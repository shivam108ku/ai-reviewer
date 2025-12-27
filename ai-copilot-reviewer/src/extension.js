const vscode = require('vscode');
const axios = require('axios');

// Global state
const diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-copilot');
let statusBarItem;
let outputChannel;
let chatPanel;
let conversationHistory = [];
let currentStreamController = null;

function activate(context) {
    console.log('🤖 AI Copilot activated!');

    outputChannel = vscode.window.createOutputChannel('AI Copilot');
    outputChannel.appendLine('✅ AI Copilot is ready!');

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(sparkle) AI Copilot";
    statusBarItem.tooltip = "Click to open AI Chat";
    statusBarItem.command = 'aiCopilotReviewer.openChat';
    statusBarItem.show();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCopilotReviewer.openChat', () => openChatPanel(context)),
        vscode.commands.registerCommand('aiCopilotReviewer.reviewFile', reviewCurrentFile),
        vscode.commands.registerCommand('aiCopilotReviewer.reviewSelection', reviewSelectedCode),
        vscode.commands.registerCommand('aiCopilotReviewer.explainCode', explainCode),
        vscode.commands.registerCommand('aiCopilotReviewer.fixCode', fixCode),
        vscode.commands.registerCommand('aiCopilotReviewer.generateTests', generateTests),
        vscode.commands.registerCommand('aiCopilotReviewer.refactorCode', refactorCode),
        vscode.commands.registerCommand('aiCopilotReviewer.clearDiagnostics', () => {
            diagnosticCollection.clear();
            vscode.window.showInformationMessage('🗑️ Reviews cleared!');
        })
    );

    // Auto-review on save
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            const config = vscode.workspace.getConfiguration('aiCopilotReviewer');
            if (config.get('reviewOnSave')) {
                await reviewDocument(doc);
            }
        })
    );

    // Register webview provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('aiCopilotChat', new ChatViewProvider(context.extensionUri))
    );

    context.subscriptions.push(diagnosticCollection, statusBarItem, outputChannel);
}

/**
 * Get API key from user input
 */
async function getApiKey() {
    const config = vscode.workspace.getConfiguration('aiCopilotReviewer');
    let apiKey = config.get('apiKey');
    
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your Google Gemini API Key',
            placeHolder: 'AIzaSy...',
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                return value.trim().length === 0 ? 'API Key cannot be empty' : null;
            }
        });
        
        if (!apiKey) {
            vscode.window.showErrorMessage('❌ API Key is required to use AI Copilot!');
            return null;
        }
        
        await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('✅ API Key saved successfully!');
    }
    
    return apiKey;
}

/**
 * Chat Panel Provider
 */
class ChatViewProvider {
    constructor(extensionUri) {
        this._extensionUri = extensionUri;
        this._view = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await handleChatMessage(data.message, webviewView.webview);
                    break;
                case 'clearChat':
                    conversationHistory = [];
                    webviewView.webview.postMessage({ type: 'clearChat' });
                    break;
                case 'stopStream':
                    if (currentStreamController) {
                        currentStreamController.abort();
                        currentStreamController = null;
                        webviewView.webview.postMessage({ 
                            type: 'streamStopped', 
                            text: '\n\n_[Response stopped by user]_' 
                        });
                    }
                    break;
            }
        });
    }

    _getHtmlForWebview(webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Copilot Chat</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Segoe UI Variable', Roboto, sans-serif;
            background: #1f1f1f;
            color: #cccccc;
            height: 100vh;
            display: flex;
            flex-direction: column;
            font-size: 13px;
        }
        .header {
            padding: 16px;
            background: #252526;
            border-bottom: 1px solid #3e3e42;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .header h2 {
            font-size: 13px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
            color: #e0e0e0;
        }
        .clear-btn {
            background: transparent;
            border: 1px solid #3e3e42;
            color: #cccccc;
            cursor: pointer;
            padding: 5px 12px;
            border-radius: 3px;
            font-size: 11px;
            transition: all 0.15s;
        }
        .clear-btn:hover {
            background: #2d2d30;
            border-color: #007acc;
        }
        .chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        .chat-container::-webkit-scrollbar {
            width: 10px;
        }
        .chat-container::-webkit-scrollbar-track {
            background: #1f1f1f;
        }
        .chat-container::-webkit-scrollbar-thumb {
            background: #3e3e42;
            border-radius: 5px;
        }
        .message {
            padding: 12px 14px;
            border-radius: 6px;
            max-width: 90%;
            line-height: 1.6;
            animation: fadeIn 0.3s ease-out;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .user-message {
            background: #007acc;
            color: #ffffff;
            align-self: flex-end;
            margin-left: auto;
            box-shadow: 0 2px 8px rgba(0, 122, 204, 0.2);
        }
        .ai-message {
            background: #2d2d30;
            border: 1px solid #3e3e42;
            align-self: flex-start;
            color: #cccccc;
        }
        .ai-message pre {
            background: #1e1e1e;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 10px 0;
            border: 1px solid #3e3e42;
        }
        .ai-message code {
            font-family: 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            color: #d4d4d4;
        }
        .ai-message p {
            margin: 8px 0;
        }
        .loading {
            display: flex;
            gap: 5px;
            padding: 10px;
            align-items: center;
        }
        .loading span {
            width: 7px;
            height: 7px;
            background: #007acc;
            border-radius: 50%;
            animation: bounce 1.4s infinite ease-in-out both;
        }
        .loading span:nth-child(1) { animation-delay: -0.32s; }
        .loading span:nth-child(2) { animation-delay: -0.16s; }
        @keyframes bounce {
            0%, 80%, 100% { transform: scale(0); }
            40% { transform: scale(1); }
        }
        .input-container {
            padding: 12px 16px;
            background: #252526;
            border-top: 1px solid #3e3e42;
            display: flex;
            gap: 8px;
        }
        .input-box {
            flex: 1;
            background: #3c3c3c;
            color: #cccccc;
            border: 1px solid #3e3e42;
            padding: 10px 12px;
            border-radius: 4px;
            font-size: 13px;
            resize: none;
            min-height: 38px;
            max-height: 120px;
            font-family: inherit;
            transition: border-color 0.15s;
        }
        .input-box:focus {
            outline: none;
            border-color: #007acc;
        }
        .send-btn, .stop-btn {
            border: none;
            padding: 10px 18px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
            font-size: 12px;
            transition: background 0.15s;
        }
        .send-btn {
            background: #007acc;
            color: #ffffff;
        }
        .send-btn:hover {
            background: #005a9e;
        }
        .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .stop-btn {
            background: #c72e0f;
            color: #ffffff;
            display: none;
        }
        .stop-btn:hover {
            background: #a02409;
        }
        .stop-btn.active {
            display: block;
        }
        .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 32px;
            color: #858585;
        }
        .empty-state h3 {
            margin: 16px 0 8px;
            font-size: 15px;
            color: #cccccc;
        }
        .suggestions {
            display: grid;
            grid-template-columns: 1fr;
            gap: 10px;
            margin-top: 20px;
            width: 100%;
            max-width: 400px;
        }
        .suggestion-btn {
            background: #2d2d30;
            color: #cccccc;
            border: 1px solid #3e3e42;
            padding: 14px 16px;
            border-radius: 6px;
            cursor: pointer;
            text-align: left;
            font-size: 12px;
            transition: all 0.15s;
        }
        .suggestion-btn:hover {
            background: #37373d;
            border-color: #007acc;
        }
        .typing-indicator {
            display: inline;
        }
    </style>
</head>
<body>
    <div class="header">
        <h2>✨ Copilot Chat</h2>
        <button class="clear-btn" onclick="clearChat()">Clear</button>
    </div>
    
    <div class="chat-container" id="chatContainer">
        <div class="empty-state">
            <h3>👋 Hi! I'm your AI coding assistant</h3>
            <p>Ask me anything about your code</p>
            <div class="suggestions">
                <button class="suggestion-btn" onclick="sendSuggestion('Review my current file')">
                    🔍 Review my current file
                </button>
                <button class="suggestion-btn" onclick="sendSuggestion('Explain this code')">
                    📖 Explain selected code
                </button>
                <button class="suggestion-btn" onclick="sendSuggestion('Find bugs and security issues')">
                    🐛 Find bugs and security issues
                </button>
                <button class="suggestion-btn" onclick="sendSuggestion('Generate unit tests')">
                    🧪 Generate unit tests
                </button>
            </div>
        </div>
    </div>
    
    <div class="input-container">
        <textarea 
            id="messageInput" 
            class="input-box" 
            placeholder="Ask Copilot a question..."
            rows="1"
        ></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()">Send</button>
        <button class="stop-btn" id="stopBtn" onclick="stopStreaming()">⏹ Stop</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chatContainer = document.getElementById('chatContainer');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const stopBtn = document.getElementById('stopBtn');
        let isStreaming = false;

        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || isStreaming) return;

            addMessage(message, 'user');
            messageInput.value = '';
            messageInput.style.height = 'auto';
            
            sendBtn.disabled = true;
            sendBtn.style.display = 'none';
            stopBtn.classList.add('active');
            isStreaming = true;

            vscode.postMessage({ type: 'sendMessage', message });
            showLoading();
        }

        function stopStreaming() {
            vscode.postMessage({ type: 'stopStream' });
            stopBtn.classList.remove('active');
            sendBtn.style.display = 'block';
            sendBtn.disabled = false;
            isStreaming = false;
            removeLoading();
        }

        function sendSuggestion(text) {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) emptyState.remove();
            
            messageInput.value = text;
            sendMessage();
        }

        function addMessage(text, type) {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${type}-message\`;
            messageDiv.innerHTML = formatMessage(text);
            chatContainer.appendChild(messageDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function formatMessage(text) {
            return text.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
                      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
                      .replace(/\\n/g, '<br>');
        }

        function showLoading() {
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'message ai-message';
            loadingDiv.id = 'loading';
            loadingDiv.innerHTML = '<div class="loading"><span></span><span></span><span></span></div>';
            chatContainer.appendChild(loadingDiv);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function removeLoading() {
            const loading = document.getElementById('loading');
            if (loading) loading.remove();
        }

        let currentTypingDiv = null;

        function typeMessage(text, callback) {
            const emptyState = chatContainer.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            currentTypingDiv = document.createElement('div');
            currentTypingDiv.className = 'message ai-message';
            currentTypingDiv.innerHTML = '<span class="typing-indicator"></span>';
            chatContainer.appendChild(currentTypingDiv);

            const typingSpan = currentTypingDiv.querySelector('.typing-indicator');
            let index = 0;
            let displayText = '';

            function typeChar() {
                if (index < text.length && isStreaming) {
                    displayText += text[index];
                    typingSpan.innerHTML = formatMessage(displayText);
                    index++;
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    setTimeout(typeChar, 20);
                } else {
                    currentTypingDiv = null;
                    if (callback) callback();
                }
            }

            typeChar();
        }

        function clearChat() {
            conversationHistory = [];
            vscode.postMessage({ type: 'clearChat' });
            chatContainer.innerHTML = '';
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.innerHTML = \`
                <h3>👋 Hi! I'm your AI coding assistant</h3>
                <p>Ask me anything about your code</p>
                <div class="suggestions">
                    <button class="suggestion-btn" onclick="sendSuggestion('Review my current file')">
                        🔍 Review my current file
                    </button>
                    <button class="suggestion-btn" onclick="sendSuggestion('Explain this code')">
                        📖 Explain selected code
                    </button>
                    <button class="suggestion-btn" onclick="sendSuggestion('Find bugs and security issues')">
                        🐛 Find bugs and security issues
                    </button>
                    <button class="suggestion-btn" onclick="sendSuggestion('Generate unit tests')">
                        🧪 Generate unit tests
                    </button>
                </div>
            \`;
            chatContainer.appendChild(emptyState);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'aiResponse':
                    removeLoading();
                    typeMessage(message.text);
                    break;
                case 'aiStreamChunk':
                    removeLoading();
                    if (!currentTypingDiv) {
                        currentTypingDiv = document.createElement('div');
                        currentTypingDiv.className = 'message ai-message';
                        currentTypingDiv.innerHTML = '<span class="typing-indicator"></span>';
                        chatContainer.appendChild(currentTypingDiv);
                    }
                    const span = currentTypingDiv.querySelector('.typing-indicator');
                    span.innerHTML = formatMessage(message.text);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    break;
                case 'aiStreamEnd':
                    currentTypingDiv = null;
                    sendBtn.disabled = false;
                    sendBtn.style.display = 'block';
                    stopBtn.classList.remove('active');
                    isStreaming = false;
                    break;
                case 'streamStopped':
                    if (currentTypingDiv) {
                        const span = currentTypingDiv.querySelector('.typing-indicator');
                        span.innerHTML += formatMessage(message.text);
                    }
                    currentTypingDiv = null;
                    sendBtn.disabled = false;
                    sendBtn.style.display = 'block';
                    stopBtn.classList.remove('active');
                    isStreaming = false;
                    break;
                case 'error':
                    removeLoading();
                    addMessage('❌ ' + message.text, 'ai');
                    sendBtn.disabled = false;
                    sendBtn.style.display = 'block';
                    stopBtn.classList.remove('active');
                    isStreaming = false;
                    break;
                case 'clearChat':
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}

/**
 * Handle chat messages with Gemini API
 */
async function handleChatMessage(message, webview) {
    conversationHistory.push({ role: 'user', parts: [{ text: message }] });

    try {
        const apiKey = await getApiKey();
        
        if (!apiKey) {
            webview.postMessage({ type: 'error', text: 'API Key not set! Please provide your Gemini API key.' });
            return;
        }

        const editor = vscode.window.activeTextEditor;
        let contextPrompt = message;
        
        if (editor && editor.document) {
            const fileName = editor.document.fileName.split(/[\\/]/).pop();
            const language = editor.document.languageId;
            const selection = editor.selection;
            const selectedText = !selection.isEmpty ? editor.document.getText(selection) : editor.document.getText();
            contextPrompt = `Context: File ${fileName} (${language})\nCode:\n${selectedText}\n\nUser Question: ${message}`;
        }

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
            {
                contents: conversationHistory.slice(-6).map(msg => ({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: msg.parts
                })),
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 2048,
                }
            }
        );

        const aiText = response.data.candidates[0].content.parts[0].text;
        conversationHistory.push({ role: 'assistant', parts: [{ text: aiText }] });
        
        webview.postMessage({ type: 'aiResponse', text: aiText });

    } catch (error) {
        console.error('Gemini API Error:', error.response?.data || error.message);
        webview.postMessage({ type: 'error', text: 'AI request failed: ' + (error.response?.data?.error?.message || error.message) });
    }
}

function openChatPanel(context) {
    vscode.commands.executeCommand('workbench.view.extension.ai-copilot-panel');
}

async function reviewCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('❌ No file open!');
        return;
    }
    await reviewDocument(editor.document);
}

async function reviewSelectedCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const code = editor.document.getText(selection);

    if (!code) {
        vscode.window.showWarningMessage('❌ No code selected!');
        return;
    }

    await reviewCode(editor.document, code, selection.start.line);
}

async function reviewDocument(document) {
    const supportedLanguages = ['javascript', 'typescript', 'python', 'java', 'cpp', 'c', 'go', 'rust'];
    
    if (!supportedLanguages.includes(document.languageId)) {
        vscode.window.showInformationMessage('⚠️ Language not supported.');
        return;
    }

    await reviewCode(document, document.getText(), 0);
}

async function reviewCode(document, code, startLine) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "AI Copilot",
        cancellable: false
    }, async (progress) => {
        progress.report({ message: "🤖 Reviewing code..." });

        try {
            const apiKey = await getApiKey();
            if (!apiKey) return;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
                {
                    contents: [{
                        parts: [{
                            text: `Code reviewer. Find bugs, security issues, bad practices. Return JSON: [{"line": number, "message": "text", "severity": "error"|"warning"|"info"}]\n\nReview:\n\n${code}`
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 2000,
                    }
                }
            );

            const aiResponse = response.data.candidates[0].content.parts[0].text;
            let issues = [];

            try {
                const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
                if (jsonMatch) issues = JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.error('Parse error:', e);
            }

            const diagnostics = issues.map(issue => {
                const line = Math.max(0, Math.min((issue.line || 1) - 1 + startLine, document.lineCount - 1));
                const range = document.lineAt(line).range;
                
                let severity = vscode.DiagnosticSeverity.Warning;
                if (issue.severity === 'error') severity = vscode.DiagnosticSeverity.Error;
                if (issue.severity === 'info') severity = vscode.DiagnosticSeverity.Information;

                const diag = new vscode.Diagnostic(range, `🤖 ${issue.message}`, severity);
                diag.source = 'AI Copilot';
                return diag;
            });

            diagnosticCollection.set(document.uri, diagnostics);

            if (diagnostics.length === 0) {
                vscode.window.showInformationMessage('✅ No issues found!');
            } else {
                vscode.window.showInformationMessage(`🔍 Found ${diagnostics.length} issue(s)`);
            }

        } catch (error) {
            vscode.window.showErrorMessage('❌ Review failed!');
        }
    });
}

async function explainCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const code = editor.document.getText(selection);

    if (!code) {
        vscode.window.showWarningMessage('❌ Select code first!');
        return;
    }

    const response = await callAI(`Explain this code concisely:\n\n${code}`);
    if (response) {
        vscode.window.showInformationMessage(response, { modal: true });
    }
}

async function fixCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const code = editor.document.getText(selection);

    if (!code) {
        vscode.window.showWarningMessage('❌ Select code first!');
        return;
    }

    const response = await callAI(`Fix bugs in this code and return only the fixed code:\n\n${code}`);
    if (response) {
        editor.edit(editBuilder => {
            editBuilder.replace(selection, response);
        });
        vscode.window.showInformationMessage('✨ Code fixed!');
    }
}

async function generateTests() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const code = editor.document.getText(selection);

    if (!code) {
        vscode.window.showWarningMessage('❌ Select function to test!');
        return;
    }

    const response = await callAI(`Generate unit tests for:\n\n${code}`);
    if (response) {
        const doc = await vscode.workspace.openTextDocument({ content: response, language: editor.document.languageId });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }
}

async function refactorCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;
    const code = editor.document.getText(selection);

    if (!code) {
        vscode.window.showWarningMessage('❌ Select code first!');
        return;
    }

    const response = await callAI(`Refactor this code for better readability and performance:\n\n${code}`);
    if (response) {
        editor.edit(editBuilder => {
            editBuilder.replace(selection, response);
        });
        vscode.window.showInformationMessage('♻️ Code refactored!');
    }
}

async function callAI(prompt) {
    try {
        const apiKey = await getApiKey();
        if (!apiKey) return null;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
            {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 1000,
                }
            }
        );

        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        vscode.window.showErrorMessage('❌ AI request failed!');
        return null;
    }
}

function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.clear();
    }
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}

module.exports = { activate, deactivate };

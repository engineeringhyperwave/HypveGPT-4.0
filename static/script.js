let chatVisible = false;
let cancelReply = false;
let currentChatTitle = null;
let liToDelete = null;
let guestChatTitles = [];
let guestChatRecords = {};
const API_URL = "/generate";

// 加载聊天标题
function loadChatTitles(userId) {
  const key = `chatTitles_${userId}`;
  const titles = JSON.parse(localStorage.getItem(key) || "[]");
  const chatList = document.getElementById("chatList");
  if (!chatList) return;
  chatList.innerHTML = "";

  titles.forEach(fullTitle => {
    const displayTitle = fullTitle.split(" #")[0];
    const li = document.createElement("li");
    li.className = "chat-title";
    li.style.display = "flex";
    li.dataset.fullTitle = fullTitle;

    const span = document.createElement("span");
    span.textContent = displayTitle;
    li.appendChild(span);

    const delBtn = document.createElement("button");
    delBtn.textContent = "X";
    delBtn.style.cssText = "margin-left:auto;background:transparent;border:none;color:white;cursor:pointer;font-weight:bold;font-size:10px;padding:2px 8px;border-radius:4px;";
    
    delBtn.onclick = (e) => {
      e.stopPropagation();
      openDeleteConfirm(li);
    };

    li.appendChild(delBtn);
    li.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      chatList.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      li.classList.add('selected');
      loadChatByTitle(userId, fullTitle);
    };

    chatList.appendChild(li);
  });
}

// 文本清理
function sanitizeText(text) {
  return text.replace(/(^[\uD800-\uDBFF](?![\uDC00-\uDFFF])|^[\uDC00-\uDFFF](?![\uD800-\uDBFF]))/g, "");
}

// 获取最后用户消息
function getLastUserMessage() {
  const currentUserId = localStorage.getItem("currentUserId");
  if (currentUserId && currentChatTitle) {
    const key = `chat_${currentUserId}_${currentChatTitle}`;
    const history = JSON.parse(localStorage.getItem(key) || "[]");
    const lastUserMsg = history.slice().reverse().find(msg => msg.role === "user");
    return lastUserMsg ? lastUserMsg.text : null;
  } else if (currentChatTitle && guestChatRecords[currentChatTitle]) {
    const lastUserMsg = guestChatRecords[currentChatTitle].slice().reverse().find(msg => msg.role === "user");
    return lastUserMsg ? lastUserMsg.text : null;
  }
  return null;
}

// 使用指定文本发送消息
async function sendMessageWithText(input) {
  const inputEl = document.getElementById("input");
  const originalValue = inputEl.value;
  inputEl.value = input;
  await sendMessage();
  inputEl.value = originalValue;
}

// 创建消息节点（增强Markdown支持 + 流式渲染优化）
function createMessage(role, text, isStreaming = false) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  let cleanText = sanitizeText(text);

  const isShort = cleanText.length < 80;
  const hasMarkdown = /[`*_#\[\]>\-]|#{1,6}\s|\|.*\|/m.test(cleanText);
  const isCodeBlock = /```[\s\S]*?```/m.test(cleanText);
  const hasTable = /\|.*\|.*\n\|[-:|]+\|/.test(cleanText);
  const useMarkdown = role === "ai" && (!isShort || hasMarkdown || isCodeBlock);

  if (useMarkdown) {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
      bubble.textContent = cleanText;
    } else {
      try {
        cleanText = cleanText.replace(/```(\w*)\n?/g, '```$1\n');
        marked.setOptions({
          breaks: true,
          gfm: true,
          tables: true,
          pedantic: false,
          smartLists: true,
          smartypants: true
        });

        let html = marked.parse(cleanText);
        html = html
          .replace(/<p>\s*(---|\*\*\*|___)\s*<\/p>/g, '<hr class="markdown-hr">')
          .replace(/<table>/g, '<table class="markdown-table">')
          .replace(/<blockquote>/g, '<blockquote class="markdown-quote">')
          .replace(/<h1>/g, '<h1 class="markdown-h1">')
          .replace(/<h2>/g, '<h2 class="markdown-h2">')
          .replace(/<h3>/g, '<h3 class="markdown-h3">');

        const sanitized = DOMPurify.sanitize(html, {
          ALLOWED_TAGS: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'br', 'hr',
            'ul', 'ol', 'li',
            'strong', 'em', 'b', 'i', 'u',
            'code', 'pre', 'blockquote',
            'table', 'thead', 'tbody', 'tr', 'th', 'td',
            'a', 'img', 'div', 'span'
          ],
          ALLOWED_ATTR: ['class', 'href', 'src', 'alt', 'title', 'target']
        });

        bubble.innerHTML = `<div class="markdown-body enhanced-markdown">${sanitized}</div>`;

        if (!isStreaming) {
          processCodeBlocksImmediately(bubble);
        } else {
          bubble.dataset.needsProcessing = "true";
          setTimeout(() => processCodeBlocksImmediately(bubble), 50);
        }
      } catch (error) {
        bubble.textContent = cleanText;
      }
    }
  } else {
    bubble.textContent = cleanText;
  }

  if (role === "ai") {
    msg.classList.add('ai-message');
    msg.dataset.messageId = Date.now();
  }

  bubble.classList.add('bubble-no-scroll');
  msg.appendChild(bubble);
  return msg;
}

// 立即处理代码块
function processCodeBlocksImmediately(container) {
  if (!container) return;
  
  if (typeof hljs !== "undefined" && hljs.highlightElement) {
    container.querySelectorAll('pre code:not([data-highlighted="true"])').forEach(block => {
      try {
        hljs.highlightElement(block);
        block.dataset.highlighted = "true";
      } catch (e) {}
    });
  }
  
  container.querySelectorAll('pre:not(.pre-with-copy)').forEach(pre => {
    if (pre.textContent.trim().length > 0) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-code-btn';
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" class="copy-icon">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
        </svg>
        <span class="copy-text">Copy</span>
      `;
      copyBtn.onclick = () => {
        const codeText = pre.innerText.replace(/Copy$/, '').trim();
        navigator.clipboard.writeText(codeText)
          .then(() => {
            const copyTextSpan = copyBtn.querySelector('.copy-text');
            if (copyTextSpan) copyTextSpan.textContent = 'Copied!';
            copyBtn.style.background = '#2b2b2b ';
            setTimeout(() => {
              if (copyTextSpan) copyTextSpan.textContent = 'Copy';
              copyBtn.style.background = '';
            }, 1500);
          });
      };
      pre.classList.add('pre-with-copy');
      pre.appendChild(copyBtn);
    }
  });
}

// 处理流式渲染代码块
function processStreamingCodeBlocks(bubble) {
  if (!bubble) return;
  if (bubble.dataset.needsProcessing === "true") {
    delete bubble.dataset.needsProcessing;
    processCodeBlocksImmediately(bubble);
  }
  processCodeBlocksImmediately(bubble);
}

// 检查是否需要Markdown
function shouldUseMarkdown(text) {
  if (!text || text.length < 30) return false;
  const hasMarkdownChars = /[`*_#\[\]>\-]|#{1,6}\s|\|.*\|/.test(text);
  const hasCodeBlock = /```[\s\S]*?```/.test(text);
  const hasList = /^[\s]*[\-\*\+]\s|\d+\.\s/.test(text);
  const hasHeading = /^#{1,6}\s+.+/m.test(text);
  const hasBlockQuote = /^>\s+.+/m.test(text);
  return hasMarkdownChars || hasCodeBlock || hasList || hasHeading || hasBlockQuote;
}

// 流式渲染器类
class StreamingRenderer {
  constructor(bubble) {
    this.bubble = bubble;
    this.lastText = '';
    this.lastUpdateTime = 0;
    this.updateThreshold = 200;
    this.updateCount = 0;
  }
  
  update(text) {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;
    const textChangedSignificantly = this.hasSignificantChange(text);
    const shouldUpdate = textChangedSignificantly || timeSinceLastUpdate > this.updateThreshold;
    
    if (shouldUpdate) {
      this.renderStreamingMarkdown(this.bubble, text);
      this.lastText = text;
      this.lastUpdateTime = now;
      this.updateCount++;
      
      if (this.updateCount % 3 === 0) {
        setTimeout(() => this.processPartialCodeBlocks(this.bubble), 10);
      }
      return true;
    }
    return false;
  }
  
  hasSignificantChange(newText) {
    if (Math.abs(newText.length - this.lastText.length) > 30) return true;
    const importantPatterns = [
      /```[\s\S]{30,}```/,
      /\n#{1,6}\s+[^\n]{15,}/,
      /\n-{3,}/,
      /\n```\w*\n[\s\S]{20,}/,
      /\n```\s*$/,
    ];
    const newPart = newText.slice(this.lastText.length);
    return importantPatterns.some(pattern => pattern.test(newPart));
  }
  
  renderStreamingMarkdown(bubble, text) {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
      bubble.textContent = text;
      return;
    }
    
    try {
      let processedText = this.preprocessStreamingMarkdown(text);
      marked.setOptions({ breaks: true, gfm: true, silent: true });
      let html = marked.parse(processedText);
      html = `<div class="streaming-markdown">${html}</div>`;
      html = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'br', 'code', 'pre', 'strong', 'em', 'b', 'i', 'u',
                      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                      'blockquote', 'hr', 'div', 'span'],
        ALLOWED_ATTR: ['class', 'data-highlighted']
      });
      bubble.innerHTML = html;
    } catch (error) {
      bubble.textContent = text;
    }
  }
  
  preprocessStreamingMarkdown(text) {
    let processed = text;
    processed = processed.replace(/```(\s*\n)/g, '```text$1');
    const backtickCount = (processed.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) processed += '\n```';
    processed = processed.replace(/(\n)[ ]{2,}([-*+]|\d+\.)/g, '$1$2');
    processed = processed.replace(/(\n)#{1,6}([^#\s])/g, '$1#$2');
    return processed;
  }
  
  processPartialCodeBlocks(bubble) {
    if (typeof hljs === "undefined") return;
    bubble.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code || code.dataset.highlighted === "true") return;
      try {
        hljs.highlightElement(code);
        code.dataset.highlighted = "true";
      } catch (e) {
        if (!code.className.includes('hljs')) code.className = 'hljs';
      }
      if (!pre.querySelector('.copy-code-btn') && code.textContent.trim().length > 10) {
        this.addCopyButtonToPre(pre);
      }
    });
  }
  
  addCopyButtonToPre(pre) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-code-btn';
    copyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" class="copy-icon">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>
      <span class="copy-text">Copy</span>
    `;
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      const codeText = pre.innerText.replace(/Copy$/, '').trim();
      navigator.clipboard.writeText(codeText)
        .then(() => {
          const copyTextSpan = copyBtn.querySelector('.copy-text');
          if (copyTextSpan) copyTextSpan.textContent = 'Copied!';
          copyBtn.style.background = '#2b2b2b';
          setTimeout(() => {
            if (copyTextSpan) copyTextSpan.textContent = 'Copy';
            copyBtn.style.background = '';
          }, 1500);
        });
    };
    pre.classList.add('pre-with-copy');
    pre.appendChild(copyBtn);
  }
  
  finalize(text) {
    try {
      if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
        marked.setOptions({ breaks: true, gfm: true, tables: true });
        let html = marked.parse(text);
        html = DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ['p', 'br', 'code', 'pre', 'strong', 'em', 'b', 'i', 'u',
                        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                        'blockquote', 'hr', 'div', 'span', 'table', 'thead',
                        'tbody', 'tr', 'th', 'td'],
          ALLOWED_ATTR: ['class', 'data-highlighted']
        });
        this.bubble.innerHTML = `<div class="markdown-body enhanced-markdown">${html}</div>`;
      } else {
        this.bubble.textContent = text;
      }
      processCodeBlocksImmediately(this.bubble);
    } catch (error) {
      this.bubble.textContent = text;
    }
  }
}

// 添加按钮到消息
function addButtonsToMessage(msg, text) {
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "message-buttons";

  const regenerateBtn = document.createElement("button");
  regenerateBtn.className = "message-btn regenerate-btn";
  regenerateBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
    </svg>
  `;
  regenerateBtn.title = "Regenerate";
  regenerateBtn.onclick = () => {
    const lastUserMessage = getLastUserMessage();
    if (lastUserMessage) sendMessageWithText(lastUserMessage);
  };
  buttonContainer.appendChild(regenerateBtn);

  const copyBtn = document.createElement("button");
  copyBtn.className = "message-btn copy-btn";
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
    </svg>
  `;
  copyBtn.title = "Copy";
  const originalCopySVG = copyBtn.innerHTML;
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#10b981" stroke-width="3">
          <path d="M5 13l4 4L19 7"/>
        </svg>
      `;
      copyBtn.title = "Copied!";
      setTimeout(() => {
        copyBtn.innerHTML = originalCopySVG;
        copyBtn.title = "Copy";
      }, 2000);
    });
  };
  buttonContainer.appendChild(copyBtn);
  msg.appendChild(buttonContainer);
}

// 保存聊天标题
function saveChatTitle(userId, title) {
  const key = `chatTitles_${userId}`;
  const titles = JSON.parse(localStorage.getItem(key) || "[]");
  if (!titles.includes(title)) {
    titles.unshift(title);
    localStorage.setItem(key, JSON.stringify(titles));
  }
}

// 保存消息
function saveChatMessageByTitle(userId, title, role, text) {
  const key = `chat_${userId}_${title}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");
  history.push({ role, text });
  localStorage.setItem(key, JSON.stringify(history));
}

// 删除聊天
function deleteChat(userId, title) {
  const titleKey = `chatTitles_${userId}`;
  const titles = JSON.parse(localStorage.getItem(titleKey) || "[]");
  const updatedTitles = titles.filter(t => t !== title);
  localStorage.setItem(titleKey, JSON.stringify(updatedTitles));
  localStorage.removeItem(`chat_${userId}_${title}`);
  loadChatTitles(userId);
  if (currentChatTitle === title) resetChat();
}

// 更新游客侧边栏
function updateGuestSidebar() {
  const chatList = document.getElementById("chatList");
  if (!chatList) return;
  guestChatTitles = JSON.parse(localStorage.getItem("guestChatTitles") || "[]");
  guestChatRecords = JSON.parse(localStorage.getItem("guestChatRecords") || "{}");
  chatList.innerHTML = "";

  guestChatTitles.forEach(fullTitle => {
    const displayTitle = fullTitle.split(" #")[0];
    const li = document.createElement("li");
    li.className = "chat-title";
    li.style.display = "flex";
    li.dataset.fullTitle = fullTitle;
    const span = document.createElement("span");
    span.textContent = displayTitle;
    li.appendChild(span);

    const delBtn = document.createElement("button");
    delBtn.textContent = "X";
    delBtn.style.cssText = "margin-left:auto;background:transparent;border:none;color:white;cursor:pointer;font-weight:bold;font-size:10px;padding:2px 8px;border-radius:4px;";
    delBtn.onclick = e => {
      e.stopPropagation();
      openDeleteConfirm(li);
    };
    li.appendChild(delBtn);

    li.onclick = e => {
      if (e.target.tagName === "BUTTON") return;
      const chat = document.getElementById("chat");
      chat.classList.add("switching");
      setTimeout(() => chat.classList.remove("switching"), 200);
      chatList.querySelectorAll("li").forEach(l => l.classList.remove("selected"));
      li.classList.add("selected");
      chat.innerHTML = "";
      chat.style.display = "flex";
      document.getElementById("title").style.display = "none";
      document.getElementById("inputContainer").classList.add("bottom-input");
      chatVisible = true;
      currentChatTitle = fullTitle;
      const history = guestChatRecords[fullTitle] || [];
      history.forEach(msg => {
        const el = createMessage(msg.role, msg.text);
        chat.appendChild(el);
        if (msg.role === "ai") addButtonsToMessage(el, msg.text);
      });
      chat.scrollTop = chat.scrollHeight;
    };
    chatList.appendChild(li);
  });

  setTimeout(() => {
    if (currentChatTitle && chatList) {
      const activeLi = [...chatList.querySelectorAll("li")].find(
        li => li.dataset.fullTitle === currentChatTitle
      );
      if (activeLi) activeLi.classList.add("selected");
    }
  }, 0);
}

// 加载指定聊天
function loadChatByTitle(userId, title) {
  if (!title) return;
  const chat = document.getElementById("chat");
  chat.classList.add("switching");
  const key = `chat_${userId}_${title}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");
  chat.innerHTML = "";
  chat.style.display = "flex";
  document.getElementById("title").style.display = "none";
  document.getElementById("inputContainer").classList.add("bottom-input");
  chatVisible = true;
  currentChatTitle = title;

  history.forEach(msg => {
    const el = createMessage(msg.role, msg.text);
    chat.appendChild(el);
    if (msg.role === "ai") addButtonsToMessage(el, msg.text);
  });

  chat.scrollTop = chat.scrollHeight;
  requestAnimationFrame(() => chat.classList.remove("switching"));
  localStorage.setItem(`lastOpenedChat_${userId}`, title);
}

// 发送消息
async function sendMessage() {
  const inputEl = document.getElementById("input");
  const input = inputEl.value.trim();
  if (!input) return;

  const chat = document.getElementById("chat");
  if (!chatVisible) {
    chat.style.display = "flex";
    document.getElementById("title").style.display = "none";
    document.getElementById("inputContainer").classList.add("bottom-input");
    chatVisible = true;
  }

  const userMsg = createMessage("user", input);
  chat.appendChild(userMsg);
  inputEl.value = "";
  resizeTextarea();
  chat.scrollTop = chat.scrollHeight;

  const loadingMsg = createMessage("ai", "⬤", true);
  chat.appendChild(loadingMsg);
  const loadingBubble = loadingMsg.querySelector(".bubble");
  loadingBubble.style.cssText = `
    display: inline-block;
    animation: pureBreathe 2s infinite ease-in-out;
    line-height: 1.6;
  `;
  if (!document.getElementById('pure-breathe')) {
    document.head.insertAdjacentHTML('beforeend', `<style id="pure-breathe">
      @keyframes pureBreathe { 0%,100% { transform: scale(0.6); } 50% { transform: scale(1.1); } }
    </style>`);
  }

  const sendBtn = document.querySelector(".send-icon");
  sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20">
    <rect x="5" y="5" width="14" height="14" rx="2" fill="#1a1a1a" stroke="white" stroke-width="3.5"/>
  </svg>`;
  sendBtn.title = "Cancel response";
  sendBtn.classList.add("pause-mode");
  sendBtn.onclick = () => {
    cancelReply = true;
    if (loadingMsg && loadingMsg.parentNode) chat.removeChild(loadingMsg);
    restoreSendButton();
  };

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ prompt: input, stream: true })
    });

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    if (loadingMsg && loadingMsg.parentNode) chat.removeChild(loadingMsg);

    const aiMsg = createMessage("ai", "", true);
    chat.appendChild(aiMsg);
    const aiBubble = aiMsg.querySelector(".bubble");
    let accumulatedText = "";
    const streamRenderer = new StreamingRenderer(aiBubble);
    let isRenderingMarkdown = false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      if (cancelReply) {
        reader.cancel();
        cancelReply = false;
        restoreSendButton();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.replace('data: ', '').trim();
          
          if (dataStr === '[DONE]') {
            streamRenderer.finalize(accumulatedText);
            processStreamingCodeBlocks(aiBubble);
            addButtonsToMessage(aiMsg, accumulatedText);
            saveChatRecords(input, accumulatedText);
            setTimeout(() => chat.scrollTop = chat.scrollHeight, 50);
            restoreSendButton();
            return;
          }

          try {
            const data = JSON.parse(dataStr);
            const token = data.response || data.content || data.token || data.delta || data.text || "";
            
            if (token) {
              accumulatedText += token;
              
              if (!isRenderingMarkdown && shouldUseMarkdown(accumulatedText)) {
                isRenderingMarkdown = true;
              }
              
              if (isRenderingMarkdown) {
                const updated = streamRenderer.update(accumulatedText);
                if (updated && accumulatedText.length % 30 === 0) {
                  chat.scrollTop = chat.scrollHeight;
                }
              } else {
                aiBubble.textContent = accumulatedText;
                if (accumulatedText.length % 30 === 0) {
                  chat.scrollTop = chat.scrollHeight;
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
      }
    }

    streamRenderer.finalize(accumulatedText);
    processStreamingCodeBlocks(aiBubble);
    addButtonsToMessage(aiMsg, accumulatedText);
    saveChatRecords(input, accumulatedText);
    setTimeout(() => chat.scrollTop = chat.scrollHeight, 50);

  } catch (error) {
    if (loadingMsg && loadingMsg.parentNode) chat.removeChild(loadingMsg);
    const errorMsg = createMessage("ai", "Sorry, server busy. Please try again.");
    chat.appendChild(errorMsg);
    addButtonsToMessage(errorMsg, "Sorry, server busy. Please try again.");
    chat.scrollTop = chat.scrollHeight;
  }

  cancelReply = false;
  restoreSendButton();
}

// 保存聊天记录
function saveChatRecords(input, rawText) {
  const currentUserId = localStorage.getItem("currentUserId");
  const isNewChat = !currentChatTitle;

  if (isNewChat) {
    const raw = input.trim();
    const preview = raw.length > 28 ? raw.slice(0, 28) + "..." : raw;
    const uniqueId = Date.now().toString(36).slice(-5).toUpperCase();
    currentChatTitle = `${preview} #${uniqueId}`;

    if (currentUserId) {
      const titles = JSON.parse(localStorage.getItem(`chatTitles_${currentUserId}`) || "[]");
      titles.unshift(currentChatTitle);
      localStorage.setItem(`chatTitles_${currentUserId}`, JSON.stringify(titles));
    } else {
      guestChatTitles.unshift(currentChatTitle);
      guestChatRecords[currentChatTitle] = [];
      localStorage.setItem("guestChatTitles", JSON.stringify(guestChatTitles));
      localStorage.setItem("guestChatRecords", JSON.stringify(guestChatRecords));
    }
  }

  if (currentUserId) {
    saveChatMessageByTitle(currentUserId, currentChatTitle, "user", input);
    saveChatMessageByTitle(currentUserId, currentChatTitle, "ai", rawText);
    loadChatTitles(currentUserId);
  } else {
    if (!guestChatRecords[currentChatTitle]) guestChatRecords[currentChatTitle] = [];
    guestChatRecords[currentChatTitle].push({ role: "user", text: input });
    guestChatRecords[currentChatTitle].push({ role: "ai", text: rawText });
    localStorage.setItem("guestChatTitles", JSON.stringify(guestChatTitles));
    localStorage.setItem("guestChatRecords", JSON.stringify(guestChatRecords));
    updateGuestSidebar();
  }
}

// 恢复发送按钮
function restoreSendButton() {
  const sendBtn = document.querySelector(".send-icon");
  sendBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="24" height="24" fill="white">
      <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
    </svg>
  `;
  sendBtn.title = "Send message";
  sendBtn.classList.remove("pause-mode");
  sendBtn.onclick = sendMessage;
}

// 重置聊天
function resetChat() {
  const chat = document.getElementById("chat");
  chat.innerHTML = "";
  chat.style.display = "none";
  document.getElementById("title").style.display = "block";
  document.getElementById("inputContainer").classList.remove("bottom-input");
  document.getElementById("input").value = "";
  chatVisible = false;
  currentChatTitle = null;
  resizeTextarea();
}

// 事件监听
document.addEventListener("keydown", function (e) {
  const inputEl = document.getElementById("input");
  if (e.key === "Enter" && !e.shiftKey && document.activeElement === inputEl) {
    e.preventDefault();
    sendMessage();
  }
});

// 登录相关
document.querySelector(".sign-in").onclick = () => {
  document.getElementById("loginModal").classList.remove("hidden");
};
document.querySelector(".sign-up").onclick = () => {
  document.getElementById("loginModal").classList.remove("hidden");
};

function closeLoginModal() {
  document.getElementById("loginModal").classList.add("hidden");
}

function handleLogin() {
  const emailInput = document.getElementById("loginEmail");
  const email = emailInput.value.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || !emailRegex.test(email)) {
    emailInput.classList.add("input-error");
    emailInput.focus();
    return;
  }

  emailInput.classList.remove("input-error");
  const fixedUserId = "guest_" + btoa(email).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  localStorage.setItem("currentUserId", fixedUserId);
  localStorage.setItem("currentUserEmail", email);
  closeLoginModal();
  showSettingsIcon(email);
  loadChatTitles(fixedUserId);
  restoreLastOpenedChat(fixedUserId);
}

document.querySelector(".google").onclick = () => {
  window.location.href = "/auth/google";
};

document.querySelector(".github").onclick = () => {
  window.location.href = "/auth/github";
};

function showSettingsIcon(email) {
  document.querySelector(".sign-in").style.display = "none";
  document.querySelector(".sign-up").style.display = "none";
  const settingsBtn = document.querySelector(".settings-button");
  settingsBtn.style.display = "inline-block";
  settingsBtn.title = email;
}

function logout() {
  localStorage.removeItem("currentUserId");
  localStorage.removeItem("currentUser");
  location.reload();
}

// 文本区域调整
const textarea = document.getElementById("input");
const inputContainer = document.getElementById("inputContainer");
let isResizing = false;

function resizeTextarea() {
  if (isResizing) return;
  isResizing = true;
  textarea.style.height = 'auto';
  const newHeight = Math.min(textarea.scrollHeight, 200);
  textarea.style.height = newHeight + 'px';
  inputContainer.style.height = newHeight + 'px';
  const sendBtn = document.querySelector('.send-icon');
  if (sendBtn) {
    sendBtn.style.top = '50%';
    sendBtn.style.transform = 'translateY(-50%)';
  }
  isResizing = false;
}

textarea.addEventListener('input', resizeTextarea);

// 页面加载
document.addEventListener("DOMContentLoaded", () => {
  resizeTextarea();

  const sidebarBtn = document.querySelector(".icon-button[title='Sidebar']");
  const toggleBtn = document.getElementById("toggleSidebar");
  const sidebar = document.getElementById("sidebar");

  function isMobileOrTablet() {
    return window.innerWidth <= 1024;
  }

  function bindSidebarToggle(button) {
    if (button && sidebar) {
      button.addEventListener("click", () => {
        sidebar.classList.toggle("visible");
      });
    }
  }

  bindSidebarToggle(sidebarBtn);
  bindSidebarToggle(toggleBtn);

  function setupOutsideClick() {
    document.addEventListener("click", (e) => {
      if (!isMobileOrTablet()) return;
      if (!sidebar.classList.contains("visible")) return;
      if (sidebar.contains(e.target)) return;
      if (sidebarBtn?.contains(e.target) || toggleBtn?.contains(e.target)) return;
      sidebar.classList.remove("visible");
    });
  }
  setupOutsideClick();

  window.addEventListener("resize", () => {
    if (!isMobileOrTablet()) sidebar.classList.remove("visible");
  });

  // 恢复登录状态
  const savedUserId = localStorage.getItem("currentUserId");
  const savedEmail = localStorage.getItem("currentUserEmail");

  if (savedUserId) {
    closeLoginModal();
    const displayEmail = savedEmail || savedUserId.startsWith("guest_")
      ? savedUserId.replace("guest_", "").slice(0, 12) + "...@guest"
      : savedUserId;
    showSettingsIcon(displayEmail);
    loadChatTitles(savedUserId);
    restoreLastOpenedChat(savedUserId);
    return;
  }

  fetch("/get-user", { credentials: "include" })
    .then(res => res.ok ? res.json() : Promise.reject())
    .then(data => {
      if (data.id && data.email) {
        localStorage.setItem("currentUserId", data.id);
        localStorage.setItem("currentUserEmail", data.email);
        showSettingsIcon(data.email);
        loadChatTitles(data.id);
                restoreLastOpenedChat(data.id);
      } else {
        throw new Error("No user");
      }
    })
    .catch(() => {
      updateGuestSidebar();
    });

  // 恢复上次打开的聊天
  function restoreLastOpenedChat(userId) {
    const lastTitle = localStorage.getItem(`lastOpenedChat_${userId}`);
    if (lastTitle) {
      setTimeout(() => {
        loadChatByTitle(userId, lastTitle);
      }, 100);
    }
  }
});

// 删除确认弹窗
function openDeleteConfirm(li) {
  liToDelete = li;
  const displayTitle = li.querySelector("span").textContent.trim();
  const h2 = document.querySelector("#deleteConfirmModal h2");
  if (h2) h2.textContent = `Delete "${displayTitle}"?`;
  document.getElementById("deleteConfirmModal").classList.remove("hidden");
  document.getElementById("deleteConfirmModal").style.display = "flex";
}

function closeDeleteModal() {
  document.getElementById("deleteConfirmModal").classList.add("hidden");
  document.getElementById("deleteConfirmModal").style.display = "none";
  liToDelete = null;
}

function confirmDelete() {
  if (!liToDelete) return;
  const realTitle = liToDelete.dataset.fullTitle;
  const userId = localStorage.getItem("currentUserId");

  if (userId) {
    deleteChat(userId, realTitle);
    loadChatTitles(userId);
  } else {
    guestChatTitles = guestChatTitles.filter(t => t !== realTitle);
    delete guestChatRecords[realTitle];
    localStorage.setItem("guestChatTitles", JSON.stringify(guestChatTitles));
    localStorage.setItem("guestChatRecords", JSON.stringify(guestChatRecords));
    updateGuestSidebar();
  }

  if (currentChatTitle === realTitle) {
    resetChat();
  }

  closeDeleteModal();
}
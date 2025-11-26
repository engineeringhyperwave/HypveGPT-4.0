let chatVisible = false;
let cancelReply = false;
let currentChatTitle = null;
let liToDelete = null;          // 替换掉了原来的 chatTitleToDelete
let guestChatTitles = [];
let guestChatRecords = {};
const API_URL = "/generate";


// ←←←←←←←←←←←←←← 把这个函数移到最顶部，全局变量下面 ←←←←←←←←←←←←←←
function loadChatTitles(userId) {
  const key = `chatTitles_${userId}`;
  const titles = JSON.parse(localStorage.getItem(key) || "[]");
  const chatList = document.getElementById("chatList");
  if (!chatList) return;
  chatList.innerHTML = "";

  titles.forEach(fullTitle => {                    // fullTitle 就是完整标题，如 "今天吃啥 #K9P4M"
    const displayTitle = fullTitle.split(" #")[0]; // 显示用的短标题

    const li = document.createElement("li");
    li.className = "chat-title";
    li.style.display = "flex";
    li.dataset.fullTitle = fullTitle;              // 关键：真实标题存在 DOM 上，永不出错！

    const span = document.createElement("span");
    span.textContent = displayTitle;
    li.appendChild(span);

    const delBtn = document.createElement("button");
    delBtn.textContent = "X";
    delBtn.style.cssText = "margin-left:auto;background:transparent;border:none;color:white;cursor:pointer;font-weight:bold;font-size:10px;padding:2px 8px;border-radius:4px;";
    
    // 删除按钮：直接从 DOM 拿真实标题
    delBtn.onclick = (e) => {
      e.stopPropagation();
      openDeleteConfirm(li);  // 直接传整个 li，里面有 dataset.fullTitle
    };

    li.appendChild(delBtn);

    // 点击标题加载聊天：直接用 fullTitle
    li.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      
      chatList.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      li.classList.add('selected');
      
      loadChatByTitle(userId, fullTitle);  // 直接传完整标题
    };

    chatList.appendChild(li);
  });
}

// 保留所有 Emoji，只删真乱码（孤立代理对）
function sanitizeText(text) {
  return text.replace(/(^[\uD800-\uDBFF](?![\uDC00-\uDFFF])|^[\uDC00-\uDFFF](?![\uD800-\uDBFF]))/g, "");
}

// 获取最后一条用户消息
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

// 创建消息节点（核心：保留 Emoji + 防 XSS）
function createMessage(role, text) {
  const msg = document.createElement("div");
  msg.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  // 保留 Emoji，只删除孤立代理对
  let cleanText = sanitizeText(text);

  // 调整代码块前后的换行
  cleanText = cleanText
    .replace(/```([\w]*)/g, '\n\n```$1')
    .replace(/\n```/g, '\n\n```');

  const hasMarkdown = /[`*_#\[\]>\-]|\b(function|const|let|var|=>|class)\b|^(---|\*\*\*|___)$/m.test(cleanText);
  const isCodeBlock = cleanText.includes("```");

  if (role === "ai" && (hasMarkdown || isCodeBlock)) {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
      console.error("Marked or DOMPurify not loaded");
      bubble.textContent = cleanText;
    } else {
      // 渲染 Markdown
      let html = marked.parse(cleanText, { breaks: true });
      html = html.replace(/<p>\s*(---|\*\*\*|___)\s*<\/p>/g, '<hr>');
      const sanitized = DOMPurify.sanitize(html);
      bubble.innerHTML = `<div class="markdown-body">${sanitized}</div>`;

      // 高亮代码块
      if (typeof hljs !== "undefined") {
        bubble.querySelectorAll('pre code').forEach(block => hljs.highlightBlock(block));
      }

      // 给每个 <pre> 添加右上角 Copy 按钮
      bubble.querySelectorAll('pre').forEach(pre => {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-code-btn';
        copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" class="copy-icon">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
          <span class="copy-text">Copy</span>
        `;
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(pre.innerText)
            .then(() => {
              copyBtn.querySelector('.copy-text').textContent = 'Copied!';
              setTimeout(() => {
                copyBtn.querySelector('.copy-text').textContent = 'Copy';
              }, 1500);
            });
        };

        pre.classList.add('pre-with-copy');
        pre.appendChild(copyBtn);
      });
    }
  } else {
    bubble.textContent = cleanText;
  }

  // AI 消息样式
  if (role === "ai") {
    msg.classList.add('ai-message');
    msg.dataset.messageId = Date.now();
  }

  // 禁用滚动条，但内容可复制
  bubble.classList.add('bubble-no-scroll');

  msg.appendChild(bubble);
  return msg;
}

// 添加按钮到 AI 消息
function addButtonsToMessage(msg, text) {
  const buttonContainer = document.createElement("div");
  buttonContainer.className = "message-buttons";

  // Regenerate 按钮
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
    if (lastUserMessage) {
      sendMessageWithText(lastUserMessage);
    }
  };
  buttonContainer.appendChild(regenerateBtn);

  // Copy 按钮
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
    }).catch(err => console.error("Copy failed:", err));
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
// 删除聊天
function deleteChat(userId, title) {
  const titleKey = `chatTitles_${userId}`;
  const titles = JSON.parse(localStorage.getItem(titleKey) || "[]");

  // 删除指定的标题
  const updatedTitles = titles.filter(t => t !== title);
  localStorage.setItem(titleKey, JSON.stringify(updatedTitles));

  // 删除该标题对应的聊天记录
  localStorage.removeItem(`chat_${userId}_${title}`);
  
  // 更新聊天界面
  loadChatTitles(userId);

  // 如果当前聊天标题是被删除的标题，重置聊天界面
  if (currentChatTitle === title) {
    resetChat(); // 重置聊天界面并清空当前聊天
  }
}


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
    li.dataset.fullTitle = fullTitle;  // 关键！

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

  // 高亮当前
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
  // title 现在传进来的一定是真实标题（比如 "hi #A1B2C"），不要再转换了！
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
  currentChatTitle = title;                    // ← 直接赋值！不要 getRealTitle！

  history.forEach(msg => {
    const el = createMessage(msg.role, msg.text);
    chat.appendChild(el);
    if (msg.role === "ai") {
      addButtonsToMessage(el, msg.text);
    }
  });

  chat.scrollTop = chat.scrollHeight;
  requestAnimationFrame(() => chat.classList.remove("switching"));

  // 保存这次打开的是哪个聊天（用于下次刷新页面自动恢复）
  localStorage.setItem(`lastOpenedChat_${userId}`, title);
}

// 发送消息
// 发送消息（改进版）
// —————————————————————————— 正确的 sendMessage() ——————————————————————————
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

  // 用户消息
  const userMsg = createMessage("user", input);
  chat.appendChild(userMsg);
  inputEl.value = "";
  resizeTextarea();
  chat.scrollTop = chat.scrollHeight;

  // AI loading
  const loadingMsg = createMessage("ai", "⬤");
  chat.appendChild(loadingMsg);
  const bubble = loadingMsg.querySelector(".bubble");
  bubble.style.cssText = `
    display: inline-block;
    animation: pureBreathe 2s infinite ease-in-out;
    line-height: 1.6;
  `;
  if (!document.getElementById('pure-breathe')) {
    document.head.insertAdjacentHTML('beforeend', `<style id="pure-breathe">
      @keyframes pureBreathe {
        0%, 100% { transform: scale(0.6); }
        50%      { transform: scale(1.1); }
      }
    </style>`);
  }

  // Cancel 按钮
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

  let stageInterval;
  const stages = ["Searching . . .", "Analyzing . . .", "Generating . . ."];
  let stageIndex = 0;

  try {
    const fetchPromise = fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ prompt: input })
    }).then(res => {
      if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
      return res.json();
    });

    const quickWait = new Promise(resolve => setTimeout(resolve, 100));
    const first = await Promise.race([fetchPromise, quickWait]);

    if (fetchPromise.done) {
      if (loadingMsg && loadingMsg.parentNode) chat.removeChild(loadingMsg);
      displayAIMessage(await fetchPromise);
    } else {
      stageInterval = setInterval(() => {
        if (cancelReply) return;
        bubble.style.animation = "";
        bubble.textContent = stages[stageIndex];
        stageIndex = Math.min(stageIndex + 1, stages.length - 1);
      }, 3000);

      const data = await fetchPromise;
      clearInterval(stageInterval);
      if (cancelReply) return;
      if (loadingMsg && loadingMsg.parentNode) chat.removeChild(loadingMsg);
      displayAIMessage(data);
    }

    function displayAIMessage(data) {
      const aiMsg = createMessage("ai", "");
      chat.appendChild(aiMsg);
      const bubble = aiMsg.querySelector(".bubble");
      const rawText = data.response || "（无回复）";

      const isShort = rawText.length < 50;
      const hasMarkdown = /[`*_#\[\]>\-]|\b(function|const|let|var|=>|class)\b|^(---|\*\*\*|___)$/m.test(rawText);
      const useMarkdown = hasMarkdown && !isShort;

      if (useMarkdown) {
        let html = marked.parse(rawText, { breaks: true });
        html = html.replace(/<p>\s*(---|\*\*\*|___)\s*<\/p>/g, '<hr>');
        html = DOMPurify.sanitize(html);

        const totalLength = html.length;
        const steps = [
          Math.floor(totalLength * 0.2),
          Math.floor(totalLength * 0.6),
          Math.floor(totalLength * 0.9),
          totalLength
        ];

        (async () => {
          for (const idx of steps) {
            if (cancelReply) break;
            bubble.innerHTML = html.slice(0, idx);
            chat.scrollTop = chat.scrollHeight;
            await new Promise(r => setTimeout(r, 200));
          }
          if (!cancelReply) addButtonsToMessage(aiMsg, rawText);
        })();
      } else {
        bubble.textContent = rawText;
        addButtonsToMessage(aiMsg, rawText);
      }

      // 正确调用（不是定义！）
      saveChatRecords(input, rawText);
    }
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
// —————————————————————————— sendMessage() 结束 ——————————————————————————



// —————————————————————————— 必须放在 sendMessage() 外面 ——————————————————————————
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

function saveChatMessageByTitle(userId, title, role, text) {
  const key = `chat_${userId}_${title}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");
  history.push({ role, text });
  localStorage.setItem(key, JSON.stringify(history));
}
// —————————————————————————— 两个函数结束 ——————————————————————————


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

document.addEventListener("keydown", function (e) {
  const inputEl = document.getElementById("input");
  if (e.key === "Enter" && !e.shiftKey && document.activeElement === inputEl) {
    e.preventDefault();
    sendMessage();
  }
});

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

  // 终极推荐方案：用 btoa(email) 生成固定且唯一的 guest ID
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

document.addEventListener("DOMContentLoaded", () => {
  resizeTextarea();

  // ====================== 你的侧边栏逻辑（完全保留）======================
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
    if (!isMobileOrTablet()) {
      sidebar.classList.remove("visible");
    }
  });
  // ====================== 侧边栏逻辑结束 ======================

  // ====================== 终极修复：自动恢复登录状态 ======================
  const savedUserId = localStorage.getItem("currentUserId");
  const savedEmail = localStorage.getItem("currentUserEmail");

  if (savedUserId) {
    // 只要 localStorage 里有 currentUserId，就认为已经登录（游客或真实用户都行）
    closeLoginModal();

    const displayEmail = savedEmail || savedUserId.startsWith("guest_")
      ? savedUserId.replace("guest_", "").slice(0, 12) + "...@guest"
      : savedUserId;

    showSettingsIcon(displayEmail);
    loadChatTitles(savedUserId);

    // 恢复上次打开的聊天（强烈推荐）
    restoreLastOpenedChat(savedUserId);

    // 重要！直接 return，阻止后面的 fetchUser 去覆盖我们本地状态
    return;
  }

  // ====================== 只有完全没登录过，才去后端检查真实登录 ======================
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
      // 后端也没登录 → 游客默认界面
      updateGuestSidebar();
    });

  // ====================== 恢复上次打开的聊天（关键函数）======================
  function restoreLastOpenedChat(userId) {
    const lastTitle = localStorage.getItem(`lastOpenedChat_${userId}`);
    if (lastTitle) {
      // 延迟一点点等 DOM 渲染完
      setTimeout(() => {
        loadChatByTitle(userId, lastTitle);
      }, 100);
    }
  }
});


// 删除确认弹窗专用函数（只加这 3 个函数）
function openDeleteConfirm(li) {
  liToDelete = li;

  // 可选：让弹窗显示具体标题（推荐）
  const displayTitle = li.querySelector("span").textContent.trim();
  const h2 = document.querySelector("#deleteConfirmModal h2");
  if (h2) h2.textContent = `Delete "${displayTitle}"?`;

  // 显示弹窗
  document.getElementById("deleteConfirmModal").classList.remove("hidden");
  document.getElementById("deleteConfirmModal").style.display = "flex";
}

// 关闭弹窗
function closeDeleteModal() {
  document.getElementById("deleteConfirmModal").classList.add("hidden");
  document.getElementById("deleteConfirmModal").style.display = "none";
  liToDelete = null;
}

// 确认删除（最核心、最安全的版本）
function confirmDelete() {
  if (!liToDelete) return;

  // 100% 准确拿到真实标题，再也不可能删错
  const realTitle = liToDelete.dataset.fullTitle;

  const userId = localStorage.getItem("currentUserId");

  if (userId) {
    // 登录用户
    deleteChat(userId, realTitle);
    loadChatTitles(userId);           // 刷新侧边栏
  } else {
    // 游客
    guestChatTitles = guestChatTitles.filter(t => t !== realTitle);
    delete guestChatRecords[realTitle];
    localStorage.setItem("guestChatTitles", JSON.stringify(guestChatTitles));
    localStorage.setItem("guestChatRecords", JSON.stringify(guestChatRecords));
    updateGuestSidebar();
  }

  // 如果删的是当前正在看的聊天 → 回到欢迎页
  if (currentChatTitle === realTitle) {
    resetChat();
  }

  closeDeleteModal();
}
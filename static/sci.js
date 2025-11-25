let chatVisible = false;
let cancelReply = false;
let currentChatTitle = null;
let guestChatTitles = [];
let guestChatRecords = {};
const API_URL = "/generate";

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

  // 只删孤立代理对，保留 Emoji
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
      let html = marked.parse(cleanText, { breaks: true });

      // 将 <p>---</p> 转换成 <hr>
      html = html.replace(/<p>\s*(---|\*\*\*|___)\s*<\/p>/g, '<hr>');

      const sanitized = DOMPurify.sanitize(html);
      bubble.innerHTML = `<div class="markdown-body">${sanitized}</div>`;
    }
  } else {
    bubble.textContent = cleanText;
  }

  if (role === "ai") {
    msg.style.display = "flex";
    msg.style.flexDirection = "column";
    msg.style.alignItems = "flex-start";
    msg.dataset.messageId = Date.now();
  }

  msg.appendChild(bubble);
  return msg;
}

// 添加按钮到 AI 消息
// 修改后的 addButtonsToMessage（关键：防重复添加！）
// 终极防重 + Copy 图标完美恢复版（复制粘贴就行）
function addButtonsToMessage(msg, text) {
  // 如果已经有了按钮组，只更新复制文本，不再加一遍
  const existing = msg.querySelector(".message-buttons");
  if (existing) {
    const copyBtn = existing.querySelector(".copy-btn");
    if (copyBtn) {
      // 直接更新 onclick 里的文本
      copyBtn.onclick = () => copyHandler(text, copyBtn);
    }
    return;
  }

  // 第一次才创建按钮
  const container = document.createElement("div");
  container.className = "message-buttons";

  // Regenerate 按钮
  const regen = document.createElement("button");
  regen.className = "message-btn regenerate-btn";
  regen.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;
  regen.title = "Regenerate";
  regen.onclick = () => {
    const last = getLastUserMessage();
    if (last) sendMessageWithText(last);
  };
  container.appendChild(regen);

  // Copy 按钮 + 完美恢复逻辑
  const copyBtn = document.createElement("button");
  copyBtn.className = "message-btn copy-btn";
  
  const normalSVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  const successSVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#10b981" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>`;

  copyBtn.innerHTML = normalSVG;
  copyBtn.title = "Copy";

  const copyHandler = (txt, btn) => {
    navigator.clipboard.writeText(txt).then(() => {
      btn.innerHTML = successSVG;
      btn.title = "Copied!";
      setTimeout(() => {
        btn.innerHTML = normalSVG;
        btn.title = "Copy";
      }, 2000);
    }).catch(() => {
      btn.title = "Copy failed";
    });
  };

  copyBtn.onclick = () => copyHandler(text, copyBtn);
  container.appendChild(copyBtn);

  msg.appendChild(container);
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
  const updated = titles.filter(t => t !== title);
  localStorage.setItem(titleKey, JSON.stringify(updated));
  localStorage.removeItem(`chat_${userId}_${title}`);
  loadChatTitles(userId);
  if (currentChatTitle === title) resetChat();
}

// 更新游客侧边栏
function updateGuestSidebar() {
  const chatList = document.getElementById("chatList");
  if (!chatList) return;
  chatList.innerHTML = "";

  guestChatTitles = JSON.parse(localStorage.getItem("guestChatTitles") || "[]");
  guestChatRecords = JSON.parse(localStorage.getItem("guestChatRecords") || "{}");

  guestChatTitles.forEach(title => {
    const li = document.createElement("li");
    li.className = "chat-title";
    li.style.display = "flex";

    const span = document.createElement("span");
    span.textContent = title;
    li.appendChild(span);

    const delBtn = document.createElement("button");
    delBtn.style.backgroundColor = "transparent";
    delBtn.style.color = "white";
    delBtn.style.border = "none";
    delBtn.style.padding = "2px 8px";
    delBtn.style.cursor = "pointer";
    delBtn.style.fontWeight = "bold";
    delBtn.style.borderRadius = "4px";
    delBtn.style.fontSize = "10px";
    delBtn.textContent = "X";
    delBtn.style.marginLeft = "auto";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      guestChatTitles = guestChatTitles.filter(t => t !== title);
      delete guestChatRecords[title];
      localStorage.setItem("guestChatTitles", JSON.stringify(guestChatTitles));
      localStorage.setItem("guestChatRecords", JSON.stringify(guestChatRecords));
      updateGuestSidebar();
      if (currentChatTitle === title) resetChat();
    };
    li.appendChild(delBtn);

    li.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      chatList.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      li.classList.add('selected');
      const chat = document.getElementById("chat");
      chat.innerHTML = "";
      chat.style.display = "flex";
      document.getElementById("title").style.display = "none";
      document.getElementById("inputContainer").classList.add("bottom-input");
      chatVisible = true;
      currentChatTitle = title;

      if (!guestChatRecords[title]) {
        guestChatRecords[title] = [];
      }
      guestChatRecords[title].forEach(msg => {
        const el = createMessage(msg.role, msg.text);
        chat.appendChild(el);
        if (msg.role === "ai") {
          addButtonsToMessage(el, msg.text);
        }
      });

      chat.scrollTop = chat.scrollHeight;

      setTimeout(() => {
        const activeLi = [...chatList.querySelectorAll('li')].find(l => 
          l.querySelector('span').textContent === title
        );
        if (activeLi) activeLi.classList.add('selected');
      }, 0);
    };

    chatList.appendChild(li);
  });

  localStorage.setItem("guestChatTitles", JSON.stringify(guestChatTitles));
  localStorage.setItem("guestChatRecords", JSON.stringify(guestChatRecords));
}

// 加载用户聊天标题
function loadChatTitles(userId) {
  const key = `chatTitles_${userId}`;
  const titles = JSON.parse(localStorage.getItem(key) || "[]");
  const chatList = document.getElementById("chatList");
  if (!chatList) return;
  chatList.innerHTML = "";

  titles.forEach(title => {
    const li = document.createElement("li");
    li.className = "chat-title";
    li.style.display = "flex";

    const span = document.createElement("span");
    span.textContent = title;
    li.appendChild(span);

    const delBtn = document.createElement("button");
    delBtn.style.backgroundColor = "transparent";
    delBtn.style.color = "white";
    delBtn.style.border = "none";
    delBtn.style.padding = "2px 8px";
    delBtn.style.cursor = "pointer";
    delBtn.style.fontWeight = "bold";
    delBtn.style.borderRadius = "4px";
    delBtn.style.fontSize = "10px";
    delBtn.textContent = "X";
    delBtn.style.marginLeft = "auto";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteChat(userId, title);
    };
    li.appendChild(delBtn);

    li.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      chatList.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      li.classList.add('selected');
      loadChatByTitle(userId, title);
    };

    chatList.appendChild(li);
  });

  setTimeout(() => {
    if (!currentChatTitle || !chatList) return;
    const activeLi = [...chatList.querySelectorAll('li')].find(li => 
      li.querySelector('span').textContent === currentChatTitle
    );
    if (activeLi) {
      chatList.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      activeLi.classList.add('selected');
    }
  }, 0);
}

// 加载指定聊天
function loadChatByTitle(userId, title) {
  const key = `chat_${userId}_${title}`;
  const history = JSON.parse(localStorage.getItem(key) || "[]");
  const chat = document.getElementById("chat");
  chat.innerHTML = "";
  chat.style.display = "flex";
  document.getElementById("title").style.display = "none";
  document.getElementById("inputContainer").classList.add("bottom-input");
  chatVisible = true;
  currentChatTitle = title;

  history.forEach(msg => {
    const el = createMessage(msg.role, msg.text);
    chat.appendChild(el);
    if (msg.role === "ai") {
      addButtonsToMessage(el, msg.text);
    }
  });

  chat.scrollTop = chat.scrollHeight;

  setTimeout(() => {
    const chatList = document.getElementById("chatList");
    if (!chatList) return;
    const activeLi = [...chatList.querySelectorAll('li')].find(li => 
      li.querySelector('span').textContent === title
    );
    if (activeLi) {
      chatList.querySelectorAll('li').forEach(l => l.classList.remove('selected'));
      activeLi.classList.add('selected');
    }
  }, 0);
}

// 发送消息
// 发送消息（终极修复版：呼吸 + 一定有答案）
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
  chat.appendChild(createMessage("user", input));
  inputEl.value = "";
  resizeTextarea();
  chat.scrollTop = chat.scrollHeight;

  // 呼吸 ⬤ loading（只变大变小，颜色透明度不变）
  const loadingMsg = createMessage("ai", "⬤");
  chat.appendChild(loadingMsg);
  chat.scrollHeight;

  const bubble = loadingMsg.querySelector(".bubble");
  bubble.style.cssText = `
    display: inline-block;
    animation: pureBreathe 2s infinite ease-in-out;
    line-height: 1.6;
  `;

  // 只注入一次呼吸动画 CSS
  if (!document.getElementById('pure-breathe')) {
    document.head.insertAdjacentHTML('beforeend', `<style id="pure-breathe">
      @keyframes pureBreathe {
        0%, 100% { transform: scale(0.6); }
        50%      { transform: scale(1.1); }
      }
    </style>`);
  }


  // 发送按钮 → 停止按钮
  const sendBtn = document.querySelector(".send-icon");
  sendBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><rect x="5" y="5" width="14" height="14" rx="2" fill="#1a1a1a" stroke="white" stroke-width="3.5"/></svg>`;
  sendBtn.title = "停止生成";
  let cancelled = false;
  sendBtn.onclick = () => {
    cancelled = true;
    if (loadingMsg && loadingMsg.parentNode) chat.removeChild(loadingMsg);
    restoreSendButton();
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ prompt: input })
    });

    if (!res.ok) throw new Error("Network error");
    const data = await res.json();
    const fullText = (data.response || "（无回复）").trim();

    if (cancelled) return;

    // 关键时刻：呼吸球消失，真·AI 气泡登场！
    chat.removeChild(loadingMsg);

    const aiMsg = createMessage("ai", "");
    chat.appendChild(aiMsg);
    addButtonsToMessage(aiMsg, "");
    chat.scrollTop = chat.scrollHeight;

    // 开始一个字一个字打出来（丝滑到起飞）
    const aiBubble = aiMsg.querySelector(".bubble");
    let displayed = "";

    for (let i = 0; i < fullText.length; i++) {
      if (cancelled) break;
      displayed += fullText[i];

      let clean = sanitizeText(displayed)
        .replace(/```([\w]*)/g, '\n\n```$1')
        .replace(/\n```/g, '\n\n```');

      if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
        let html = marked.parse(clean, { breaks: true });
        html = html.replace(/<p>\s*(---|\*\*\*|___)\s*<\/p>/g, '<hr>');
        aiBubble.innerHTML = `<div class="markdown-body">${DOMPurify.sanitize(html)}</div>`;
      } else {
        aiBubble.textContent = clean;
      }

      chat.scrollTop = chat.scrollHeight;
      await new Promise(r => setTimeout(r, 16)); // 超快打字，改成 8 更快
    }

    // 最终更新复制按钮
    addButtonsToMessage(aiMsg, fullText);

    // 保存聊天记录（你原来逻辑 100% 保留）
    const currentUserId = localStorage.getItem("currentUserId");
    const isNewChat = !currentChatTitle;

    if (isNewChat) {
      currentChatTitle = input.length > 30 ? input.slice(0, 30) + "..." : input;
      if (currentUserId) {
        saveChatTitle(currentUserId, currentChatTitle);
      } else {
        guestChatTitles.unshift(currentChatTitle);
        guestChatRecords[currentChatTitle] = [];
        saveGuestData();
      }
    }

    if (currentUserId) {
      saveChatMessageByTitle(currentUserId, currentChatTitle, "user", input);
      saveChatMessageByTitle(currentUserId, currentChatTitle, "ai", fullText);
      loadChatTitles(currentUserId);
    } else {
      if (!guestChatRecords[currentChatTitle]) guestChatRecords[currentChatTitle] = [];
      guestChatRecords[currentChatTitle].push({ role: "user", text: input });
      guestChatRecords[currentChatTitle].push({ role: "ai", text: fullText });
      saveGuestData();
      updateGuestSidebar();
    }

  } catch (error) {
    if (!cancelled) {
      chat.removeChild(loadingMsg);
      const errMsg = createMessage("ai", "Sorry, server error. Please try again?");
      chat.appendChild(errMsg);
      addButtonsToMessage(errMsg, "Sorry, server error. Please try again?");
    }
  } finally {
    if (!cancelled) restoreSendButton();
  }
}

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
  const email = emailInput.value.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || !emailRegex.test(email)) {
    emailInput.classList.add("input-error");
    emailInput.focus();
    return;
  }

  emailInput.classList.remove("input-error");
  const tempUserId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  localStorage.setItem("currentUserId", tempUserId);
  localStorage.removeItem("currentUser");
  closeLoginModal();
  showSettingsIcon(email);
  loadChatTitles(tempUserId);
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

  const sidebarBtn = document.querySelector(".icon-button[title='Sidebar']");
  const toggleBtn = document.getElementById("toggleSidebar");
  const sidebar = document.getElementById("sidebar");

  function bindSidebarToggle(button) {
    if (button && sidebar) {
      button.addEventListener("click", () => {
        sidebar.classList.toggle("visible");
      });
    }
  }

  bindSidebarToggle(sidebarBtn);
  bindSidebarToggle(toggleBtn);

  function fetchUser() {
    fetch("/get-user", { credentials: "include" })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (data.id && data.email) {
          localStorage.setItem("currentUserId", data.id);
          localStorage.removeItem("currentUser");
          showSettingsIcon(data.email);
          loadChatTitles(data.id);
        } else {
          localStorage.removeItem("currentUserId");
          updateGuestSidebar();
        }
      })
      .catch(error => {
        console.error("获取用户状态失败:", error);
        updateGuestSidebar();
      });
  }

  const userId = localStorage.getItem("currentUserId");
  const urlParams = new URLSearchParams(window.location.search);
  const isLoginRedirect = urlParams.get('login') === 'success';

  if (userId) {
    fetch("/get-user", { credentials: "include" })
      .then(res => res.json())
      .then(data => {
        if (data.email) showSettingsIcon(data.email);
      });
    loadChatTitles(userId);
  } else {
    fetchUser();
  }

  if (isLoginRedirect) {
    fetchUser();
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});
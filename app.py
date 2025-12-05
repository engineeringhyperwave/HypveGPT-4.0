from flask import Flask, request, jsonify, render_template, session, redirect, url_for, g, Response
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from authlib.integrations.flask_client import OAuth
import requests
import os
import secrets
import json
from dotenv import load_dotenv
from functools import wraps
from itsdangerous import URLSafeTimedSerializer
import logging
import uuid
import re

load_dotenv()

app = Flask(__name__, static_folder="static", template_folder="templates")

# ================== 基础配置 ==================
app.secret_key = os.getenv("FLASK_SECRET_KEY") or os.urandom(32)
is_dev = os.getenv("FLASK_ENV") == "development"

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=not is_dev,
    SESSION_COOKIE_SAMESITE='Lax' if is_dev else 'None'
)

# CORS
allowed_origins = os.getenv("ALLOWED_ORIGIN", "").split(",") if os.getenv("ALLOWED_ORIGIN") else [
    "http://localhost:3000", "http://127.0.0.1:5500",
    "https://localhost:3000", "https://127.0.0.1:5500"
]
CORS(app, origins=allowed_origins, supports_credentials=True)

# Limiter
limiter = Limiter(app=app, key_func=get_remote_address)

# HuggingFace
HF_API_KEY = os.getenv("HF_API_KEY")
API_URL = "https://router.huggingface.co/v1/chat/completions"

# OAuth
oauth = OAuth(app)
serializer = URLSafeTimedSerializer(app.secret_key)

github = oauth.register(
    name='github',
    client_id=os.getenv('GITHUB_CLIENT_ID'),
    client_secret=os.getenv('GITHUB_CLIENT_SECRET'),
    access_token_url='https://github.com/login/oauth/access_token',
    authorize_url='https://github.com/login/oauth/authorize',
    api_base_url='https://api.github.com/',
    client_kwargs={'scope': 'user:email'}
)

google = oauth.register(
    name='google',
    client_id=os.getenv('GOOGLE_CLIENT_ID'),
    client_secret=os.getenv('GOOGLE_CLIENT_SECRET'),
    access_token_url='https://oauth2.googleapis.com/token',
    authorize_url='https://accounts.google.com/o/oauth2/auth',
    api_base_url='https://www.googleapis.com/oauth2/v2/',
    client_kwargs={'scope': 'openid email profile', 'prompt': 'consent'}
)

# ================== 日志 + 请求ID ==================
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@app.before_request
def before_request():
    g.request_id = str(uuid.uuid4())[:8]

def log_info(msg):
    logger.info(f"[{g.request_id}] {msg}")

# ================== 工具函数 ==================
def generate_oauth_state():
    state = secrets.token_urlsafe(32)
    session['oauth_state'] = state
    return state

def get_current_user():
    try:
        if not session.get('user'):
            return None
        return serializer.loads(session['user'], max_age=3600)
    except Exception:
        session.pop('user', None)
        return None

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not get_current_user():
            return jsonify({"email": None}), 401
        return f(*args, **kwargs)
    return decorated

# ================== System Prompt ==================
SYSTEM_PROMPT = """
You are HypveGPT, an AI assistant. 
Guidelines:
1. Respond clearly, helpfully, and politely. Use Markdown, code blocks, horizontal lines, and emojis when explaining concepts, tutorials, or giving detailed responses.
2. For short answers or greetings, plain text without Markdown or emojis is fine.
3. Only state your origin if explicitly asked. When asked about your origin, always answer that you were developed by Hyperwave Systems Engineering Sdn Bhd. Never claim to be Deepseek or any open-source model.
4. Avoid unnecessary self-description; focus on answering the user's questions.
Always maintain a friendly and professional tone.
""".strip()

# ================== 优化的流式生成函数 ==================
def generate_stream_fast(payload, request_id, user_info):
    """
    优化的流式生成函数 - 使用真正的流式API，无延迟
    """
    try:
        logger.info(f"[{request_id}] 开始流式请求 | 用户: {user_info}")
        
        # 🟢 使用真正的流式API
        response = requests.post(
            API_URL,
            headers={
                "Authorization": f"Bearer {HF_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                **payload,
                "stream": True  # 关键：启用流式
            },
            stream=True,  # 关键：保持连接打开
            timeout=30
        )
        response.raise_for_status()
        
        logger.info(f"[{request_id}] 流式连接建立成功")
        
        # 🟢 直接转发流式响应，无延迟
        for line in response.iter_lines():
            if line:
                line = line.decode('utf-8')
                
                if line.startswith('data: '):
                    data_str = line[6:]
                    
                    if data_str == '[DONE]':
                        logger.info(f"[{request_id}] 流式传输完成")
                        yield "data: [DONE]\n\n"
                        break
                    
                    try:
                        data = json.loads(data_str)
                        
                        # 提取token内容
                        token = ""
                        if 'choices' in data and len(data['choices']) > 0:
                            choice = data['choices'][0]
                            if 'delta' in choice and 'content' in choice['delta']:
                                token = choice['delta']['content']
                            elif 'text' in choice:
                                token = choice['text']
                        
                        if token:
                            yield f"data: {json.dumps({'response': token})}\n\n"
                            
                    except json.JSONDecodeError:
                        # 忽略非JSON行
                        continue
        
    except requests.exceptions.Timeout:
        logger.error(f"[{request_id}] 流式请求超时")
        yield f"data: {json.dumps({'response': '请求超时，请稍后重试'})}\n\n"
        yield "data: [DONE]\n\n"
        
    except requests.exceptions.RequestException as e:
        error_msg = "服务暂时不可用"
        if hasattr(e, 'response') and e.response:
            if e.response.status_code == 429:
                error_msg = "请求太频繁，请稍后再试"
            elif e.response.status_code == 401:
                error_msg = "认证失败"
                logger.error(f"[{request_id}] API密钥失效")
        
        logger.error(f"[{request_id}] 流式请求异常: {str(e)[:100]}")
        yield f"data: {json.dumps({'response': error_msg})}\n\n"
        yield "data: [DONE]\n\n"
        
    except Exception as e:
        logger.error(f"[{request_id}] 流式生成异常: {e}")
        yield f"data: {json.dumps({'response': '生成过程中出现错误'})}\n\n"
        yield "data: [DONE]\n\n"

def generate_stream_simple(payload, request_id, user_info):
    """
    备用方案：快速非流式回复（最快）
    """
    try:
        logger.info(f"[{request_id}] 开始快速请求 | 用户: {user_info}")
        
        # 获取完整回复
        resp = requests.post(
            API_URL,
            headers={"Authorization": f"Bearer {HF_API_KEY}"},
            json=payload,
            timeout=30
        )
        resp.raise_for_status()
        
        data = resp.json()
        full_text = data["choices"][0]["message"]["content"]
        
        logger.info(f"[{request_id}] 快速请求完成 | 长度: {len(full_text)}")
        
        # 🟢 立即发送完整回复（前端会作为流式处理）
        yield f"data: {json.dumps({'response': full_text})}\n\n"
        yield f"data: {json.dumps({'full_text': full_text})}\n\n"
        yield "data: [DONE]\n\n"
        
    except Exception as e:
        logger.error(f"[{request_id}] 快速请求异常: {e}")
        yield f"data: {json.dumps({'response': '请求失败，请重试'})}\n\n"
        yield "data: [DONE]\n\n"

# ================== 路由 ==================
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/generate", methods=["POST"])
@limiter.limit("30/minute", key_func=lambda: get_current_user().get("id") if get_current_user() else get_remote_address())
@limiter.limit("8/minute")
def generate():
    if not HF_API_KEY:
        return jsonify({"response": "Server configuration error."}), 500

    user_input = request.json.get("prompt", "").strip()
    stream = request.json.get("stream", False)
    
    if not user_input:
        return jsonify({"response": "请输入内容"}), 400
    if len(user_input) > 3000:
        return jsonify({"response": "消息太长，最多 3000 字"}), 400

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_input}
    ]

    payload = {
        "model": "deepseek-ai/DeepSeek-V3.2-Exp",
        "messages": messages,
        "max_tokens": 2048,
        "temperature": 0.7
    }

    try:
        # 用户信息
        user_info = get_current_user()
        user_email = user_info.get('email', 'guest') if user_info else 'guest'
        request_id = str(uuid.uuid4())[:8]
        
        log_info(f"生成请求开始 | prompt长度: {len(user_input)} | 用户: {user_email}")
        
        if stream:
            # 🟢 使用优化的流式生成函数
            return Response(
                generate_stream_fast(payload, request_id, user_email),  # 真正的流式API
                # generate_stream_simple(payload, request_id, user_email),  # 备用：快速非流式
                mimetype='text/event-stream',
                headers={
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                    'X-Request-ID': request_id
                }
            )
        else:
            # 非流式模式
            resp = requests.post(
                API_URL,
                headers={"Authorization": f"Bearer {HF_API_KEY}"},
                json=payload,
                timeout=30
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]
            
            log_info(f"非流式生成成功 | 用户: {user_email} | 长度: {len(reply)}")
            return jsonify({"response": reply})

    except requests.exceptions.RequestException as e:
        error_msg = "模型暂时不可用，请稍后重试"
        if hasattr(e, "response") and e.response:
            if e.response.status_code == 429:
                error_msg = "请求太频繁，请稍后再试"
            elif e.response.status_code == 401:
                error_msg = "服务认证失败"
                logger.error("HF API Key 失效")
        
        log_info(f"API请求失败: {e}")
        
        if stream:
            def error_stream():
                yield f"data: {json.dumps({'response': error_msg})}\n\n"
                yield "data: [DONE]\n\n"
            return Response(error_stream(), mimetype='text/event-stream')
        else:
            return jsonify({"response": error_msg}), 503
            
    except Exception as e:
        logger.error(f"意外错误: {e}", exc_info=True)
        error_msg = "服务开小差了，请稍后重试"
        
        if stream:
            def unexpected_error_stream():
                yield f"data: {json.dumps({'response': error_msg})}\n\n"
                yield "data: [DONE]\n\n"
            return Response(unexpected_error_stream(), mimetype='text/event-stream')
        else:
            return jsonify({"response": error_msg}), 500

# ================== OAuth ==================
@app.route("/auth/github")
def auth_github():
    redirect_uri = url_for('auth_github_callback', _external=True, _scheme="https")
    return github.authorize_redirect(redirect_uri, state=generate_oauth_state())

@app.route("/auth/callback/github")
def auth_github_callback():
    if request.args.get('state') != session.pop('oauth_state', None):
        return "Invalid state", 400
    token = github.authorize_access_token()
    user = github.get('user').json()
    session['user'] = serializer.dumps({
        'id': str(user.get('id')),
        'email': user.get('email') or f"{user.get('login')}@github.local",
        'name': user.get('name') or user.get('login')
    })
    return redirect("/?login=success")

@app.route("/auth/google")
def auth_google():
    redirect_uri = url_for('auth_google_callback', _external=True, _scheme="https")
    return google.authorize_redirect(redirect_uri, state=generate_oauth_state())

@app.route("/auth/callback/google")
def auth_google_callback():
    if request.args.get('state') != session.pop('oauth_state', None):
        return "Invalid state", 400
    token = google.authorize_access_token()
    user = google.get('userinfo').json()
    session['user'] = serializer.dumps({
        'id': user.get('id'),
        'email': user.get('email'),
        'name': user.get('name')
    })
    return redirect("/?login=success")

@app.route("/get-user")
@login_required
def get_user():
    user = get_current_user()
    return jsonify({"email": user['email'], "name": user.get('name'), "id": user['id']})

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")

@app.route("/health")
def health():
    return "OK", 200

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    # 使用gevent优化流式性能
    try:
        from gevent import monkey
        monkey.patch_all()
        from gevent.pywsgi import WSGIServer
        print(f"🚀 服务器启动在 http://0.0.0.0:{port} (gevent模式 - 优化流式性能)")
        http_server = WSGIServer(('0.0.0.0', port), app)
        http_server.serve_forever()
    except ImportError:
        print(f"🚀 服务器启动在 http://0.0.0.0:{port} (Flask开发模式)")
        app.run(host="0.0.0.0", port=port, debug=is_dev, threaded=True)
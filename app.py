from flask import Flask, request, jsonify, render_template, session, redirect, url_for
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from authlib.integrations.flask_client import OAuth
from werkzeug.middleware.proxy_fix import ProxyFix # 必须添加
import requests
import os
import secrets
from dotenv import load_dotenv
from functools import wraps
from itsdangerous import URLSafeTimedSerializer

# 加载环境变量
load_dotenv()

app = Flask(__name__, static_folder="static", template_folder="templates")

# 重要：处理代理（Hugging Face & Cloudflare 必备）
# 这样 url_for 才会生成 https://secretaistudio.com 而不是 http
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# ====== 安全配置 ======
app.secret_key = os.getenv("FLASK_SECRET_KEY") or os.urandom(32)

# Cookie 安全设置
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True, # 生产环境始终开启
    SESSION_COOKIE_SAMESITE='Lax'
)

# CORS 域名白名单（包含你的新域名）
allowed_origins = [
    "https://secretaistudio.com",
    "https://www.secretaistudio.com",
    "https://*.hf.space",  # 允许 HF 预览链接
]
CORS(app, origins=allowed_origins, supports_credentials=True)

# 频率限制 (默认使用内存，如果没配 Redis 的话)
limiter = Limiter(app=app, key_func=get_remote_address)

# 模型 API 配置
HF_API_KEY = os.getenv("HF_API_KEY")
API_URL = "https://router.huggingface.co/v1/chat/completions"

# OAuth 设置
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

# ====== 路由逻辑保持不变 (除了端口) ======

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/generate", methods=["POST"])
@limiter.limit("15/minute")
def generate():
    if not HF_API_KEY:
        return jsonify({"response": "Server configuration error."}), 500
    user_input = request.json.get("prompt", "").strip()
    if not user_input or len(user_input) > 2000:
        return jsonify({"response": "Input is empty or too long."}), 400

    messages = [
        {"role": "system", "content": "You are HypveGPT, a helpful AI assistant."},
        {"role": "user", "content": user_input}
    ]
    headers = {"Authorization": f"Bearer {HF_API_KEY}"}
    payload = {
        "model": "deepseek-ai/DeepSeek-V3", # 确保模型 ID 正确
        "messages": messages,
        "max_tokens": 1024,
        "temperature": 0.7
    }

    try:
        response = requests.post(API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        reply = response.json()["choices"][0]["message"]["content"]
        return jsonify({"response": reply})
    except Exception as e:
        return jsonify({"response": "Service error."}), 500

# OAuth 回调路由 (保持不变)
@app.route("/auth/github")
def auth_github():
    redirect_uri = url_for('auth_github_callback', _external=True)
    return github.authorize_redirect(redirect_uri)

@app.route("/auth/callback/github")
def auth_github_callback():
    token = github.authorize_access_token()
    user = github.get('user').json()
    session['user'] = serializer.dumps({'id': user.get('id'), 'email': user.get('email')})
    return redirect("/")

@app.route("/auth/google")
def auth_google():
    redirect_uri = url_for('auth_google_callback', _external=True)
    return google.authorize_redirect(redirect_uri)

@app.route("/auth/callback/google")
def auth_google_callback():
    token = google.authorize_access_token()
    user = google.get('userinfo').json()
    session['user'] = serializer.dumps({'id': user.get('id'), 'email': user.get('email')})
    return redirect("/")

@app.route("/logout")
def logout():
    session.clear()
    return redirect("/")

# ====== 启动配置 ======
if __name__ == "__main__":
    # Hugging Face 必须监听 7860 端口
    port = int(os.getenv("PORT", 7860))
    app.run(host="0.0.0.0", port=port)
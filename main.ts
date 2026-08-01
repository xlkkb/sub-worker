// ==========================================
// 1. 基础配置与路径格式自动修正
// ==========================================
const ADMIN_USER = Deno.env.get("ADMIN_USER") || "admin";
const ADMIN_PASS = Deno.env.get("ADMIN_PASS") || "123456";
const SUB_TOKEN  = Deno.env.get("SUB_TOKEN")  || "sub123";

let configuredPath = (Deno.env.get("ADMIN_PATH") || "/dashboard").trim();
if (!configuredPath.startsWith("/")) {
    configuredPath = "/" + configuredPath;
}
if (configuredPath.endsWith("/") && configuredPath.length > 1) {
    configuredPath = configuredPath.slice(0, -1);
}
const ADMIN_PATH = configuredPath;

const KV_KEY = ['links_data'];
const AUTH_COOKIE_NAME = "deno_sub_session";
const AUTH_COOKIE_VALUE = btoa(`${ADMIN_USER}:${ADMIN_PASS}`);

Deno.serve(async (req) => {
    try {
        const url = new URL(req.url);
        
        let path = url.pathname;
        if (path.endsWith("/") && path.length > 1) {
            path = path.slice(0, -1);
        }

        let kv;
        try {
            kv = await Deno.openKv();
        } catch (e: any) {
            return new Response("Deno KV 连接失败: " + e.message, { status: 500 });
        }

        const cookieHeader = req.headers.get("cookie") || "";
        const isLoggedIn = cookieHeader.includes(`${AUTH_COOKIE_NAME}=${AUTH_COOKIE_VALUE}`);

        // ==========================================
        // 2. 登录 / 登出 处理
        // ==========================================
        if (path === `${ADMIN_PATH}/login` && req.method === "POST") {
            const formData = await req.formData();
            const user = formData.get("username");
            const pass = formData.get("password");

            if (user === ADMIN_USER && pass === ADMIN_PASS) {
                return new Response(null, {
                    status: 302,
                    headers: {
                        "Location": ADMIN_PATH,
                        "Set-Cookie": `${AUTH_COOKIE_NAME}=${AUTH_COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax`
                    }
                });
            } else {
                return renderLoginPage("用户名或密码错误！");
            }
        }

        if (path === `${ADMIN_PATH}/logout`) {
            return new Response(null, {
                status: 302,
                headers: {
                    "Location": ADMIN_PATH,
                    "Set-Cookie": `${AUTH_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
                }
            });
        }

        // ==========================================
        // 3. 管理后台页面路径 (ADMIN_PATH)
        // ==========================================
        if (path === ADMIN_PATH) {
            if (!isLoggedIn) {
                return renderLoginPage();
            }

            if (req.method === "POST") {
                try {
                    const bodyText = await req.text();
                    await kv.set(KV_KEY, bodyText);
                    return new Response("保存成功");
                } catch (error: any) {
                    return new Response("KV 保存失败: " + error.message, { status: 500 });
                }
            }

            const res = await kv.get(KV_KEY);
            const currentContent = res.value || "";
            return renderDashboardPage(currentContent, url.origin);
        }

        // ==========================================
        // 4. 节点订阅拉取接口 (/sub?token=xxx)
        // ==========================================
        const reqToken = url.searchParams.get("token") || path.replace("/sub/", "").replace("/sub", "");
        if (path.startsWith("/sub") || url.searchParams.has("token")) {
            if (reqToken !== SUB_TOKEN) {
                return new Response("Unauthorized. Invalid Subscription Token.", { status: 401 });
            }

            const res = await kv.get(KV_KEY);
            const rawContent = res.value || "";

            // 解析节点：剥离 # 注释与过滤空行
            const lines = rawContent.split('\n')
                .map(line => {
                    const commentIdx = line.indexOf('#');
                    if (commentIdx !== -1) {
                        line = line.substring(0, commentIdx);
                    }
                    return line.trim();
                })
                .filter(line => line.length > 0);

            let nodes: string[] = [];
            let fetchPromises = [];

            for (const line of lines) {
                if (line.startsWith('http://') || line.startsWith('https://')) {
                    // 为每个订阅源请求增加 4秒 强制超时熔断，防止死锁卡顿
                    fetchPromises.push(
                        fetch(line, { 
                            headers: { 'User-Agent': 'v2rayN/6.0' },
                            signal: AbortSignal.timeout(4000) 
                        })
                        .then(r => r.ok ? r.text() : '')
                        .catch(() => '') // 无论网络超时还是连接报错，直接无视跳过
                    );
                } else {
                    nodes.push(line);
                }
            }

            const subContents = await Promise.all(fetchPromises);
            for (let sub of subContents) {
                if (!sub) continue;
                sub = sub.trim();
                let decoded = sub;
                if (!sub.includes('://')) {
                    try {
                        decoded = atob(sub.replace(/-/g, '+').replace(/_/g, '/'));
                    } catch {}
                }
                const subNodes = decoded.split('\n')
                    .map(l => {
                        const cIdx = l.indexOf('#');
                        return (cIdx !== -1 ? l.substring(0, cIdx) : l).trim();
                    })
                    .filter(l => l.length > 0);
                nodes.push(...subNodes);
            }

            // 按协议排序分组
            const protocolGroups: Record<string, string[]> = {};
            for (const node of nodes) {
                const match = node.match(/^([a-zA-Z0-9]+):\/\//);
                if (match) {
                    const protocol = match[1].toLowerCase();
                    if (!protocolGroups[protocol]) protocolGroups[protocol] = [];
                    protocolGroups[protocol].push(node);
                } else {
                    if (!protocolGroups['other']) protocolGroups['other'] = [];
                    protocolGroups['other'].push(node);
                }
            }

            let groupedNodes: string[] = [];
            for (const proto of Object.keys(protocolGroups).sort()) {
                groupedNodes.push(...protocolGroups[proto]);
            }

            const finalString = groupedNodes.join('\n');
            const finalBase64 = encodeBase64(finalString);

            return new Response(finalBase64, {
                headers: { "content-type": "text/plain; charset=utf-8" }
            });
        }

        return new Response("Not Found", { status: 404 });

    } catch (err: any) {
        return new Response("程序运行异常: " + (err?.message || String(err)), { 
            status: 500,
            headers: { "content-type": "text/plain;charset=utf-8" }
        });
    }
});

function renderLoginPage(errorMsg = "") {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>后台登录</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f4f6f9; margin: 0; }
            .login-card { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 320px; }
            h2 { margin-top: 0; text-align: center; color: #333; }
            input { width: 100%; padding: 10px; margin: 10px 0; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; }
            button { width: 100%; padding: 10px; background: #007bff; color: white; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
            button:hover { background: #0056b3; }
            .error { color: #dc3545; font-size: 14px; text-align: center; margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <div class="login-card">
            <h2>管理员登录</h2>
            ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
            <form action="${ADMIN_PATH}/login" method="POST">
                <input type="text" name="username" placeholder="用户名" required autofocus>
                <input type="password" name="password" placeholder="密码" required>
                <button type="submit">登录</button>
            </form>
        </div>
    </body>
    </html>`;
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

function renderDashboardPage(currentContent: string, origin: string) {
    const subUrl = `${origin}/sub?token=${SUB_TOKEN}`;
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Deno 节点聚合管理器</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: -apple-system, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; color: #333; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
            textarea { width: 100%; height: 350px; margin-bottom: 15px; padding: 12px; box-sizing: border-box; font-family: monospace; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; }
            button { padding: 10px 24px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 15px; }
            button:hover { background: #0056b3; }
            .logout-btn { background: #6c757d; padding: 6px 12px; text-decoration: none; color: white; border-radius: 4px; font-size: 14px; }
            .info-box { margin-top: 25px; padding: 15px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef; word-break: break-all; }
            .info-box a { color: #007bff; text-decoration: none; }
            .hint { color: #666; font-size: 13px; margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Deno 节点聚合管理器</h2>
            <a href="${ADMIN_PATH}/logout" class="logout-btn">退出登录</a>
        </div>
        <p class="hint">提示：支持 <code>#</code> 添加注释（整行或行尾注释），空行自动跳过。</p>
        <textarea id="content" placeholder="https://example.com/sub # 订阅源1&#10;# 这是一个忽略的注释行&#10;vmess://......">${currentContent}</textarea>
        <div>
            <button onclick="save()">保存配置</button>
            <span id="status" style="margin-left: 15px; color: #28a745; font-weight: bold;"></span>
        </div>

        <div class="info-box">
            <strong>👉 您的最终聚合订阅地址（填入代理客户端）：</strong><br><br>
            <a href="${subUrl}" target="_blank">${subUrl}</a>
        </div>

        <script>
            function save() {
                const text = document.getElementById('content').value;
                const status = document.getElementById('status');
                status.textContent = '保存中...';
                
                fetch(window.location.href, {
                    method: 'POST',
                    body: text
                }).then(res => {
                    if(res.ok) status.textContent = '✔ 保存成功';
                    else status.textContent = '❌ 保存失败';
                    setTimeout(() => status.textContent = '', 3000);
                }).catch(() => {
                    status.textContent = '❌ 网络请求异常';
                });
            }
        </script>
    </body>
    </html>`;
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
}

function encodeBase64(data: string) {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

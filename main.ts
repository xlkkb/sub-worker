const DEFAULT_TOKEN = 'auto'; 
const KV_KEY = ['links_data'];

Deno.serve(async (req) => {
    try {
        const url = new URL(req.url);
        const token = url.searchParams.get('token') || url.pathname.slice(1);
        const authKey = Deno.env.get("TOKEN") || DEFAULT_TOKEN;

        // 1. 强制登录鉴权
        if (token !== authKey && !url.searchParams.has('sub')) {
            return new Response("Unauthorized. Access Denied.", { status: 401 });
        }

        // 明确指定连接名为 "KV" 的数据库
        let kv;
        try {
            kv = await Deno.openKv("KV");
        } catch (e: any) {
            return new Response("Deno KV 连接失败: " + e.message, { status: 500 });
        }

        const userAgent = req.headers.get("user-agent")?.toLowerCase() || "";
        const isBrowser = userAgent.includes("mozilla") && !url.searchParams.has("sub");

        // ==========================================
        // 前台：KV 订阅编辑与管理页面
        // ==========================================
        if (isBrowser) {
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

            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Deno 节点聚合管理器</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; color: #333; }
                    textarea { width: 100%; height: 350px; margin-bottom: 15px; padding: 12px; box-sizing: border-box; font-family: monospace; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; }
                    button { padding: 10px 24px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
                    button:hover { background: #0056b3; }
                    .info-box { margin-top: 25px; padding: 15px; background: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef; word-break: break-all; }
                    .info-box a { color: #007bff; text-decoration: none; }
                </style>
            </head>
            <body>
                <h2>Deno 节点聚合管理器</h2>
                <p>输入你的订阅链接或直连节点，每行一个：</p>
                <textarea id="content" placeholder="https://example.com/sub\nvmess://......">${currentContent}</textarea>
                <div>
                    <button onclick="save()">保存到 KV</button>
                    <span id="status" style="margin-left: 15px; color: #28a745; font-weight: bold;"></span>
                </div>

                <div class="info-box">
                    <strong>👉 您的最终聚合订阅地址：</strong><br><br>
                    <a href="${url.origin}/${authKey}?sub=1" target="_blank">${url.origin}/${authKey}?sub=1</a>
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
            </html>
            `;
            return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
        }

        // ==========================================
        // 后台：多源抓取、高端口支持、协议聚类
        // ==========================================
        const res = await kv.get(KV_KEY);
        const rawContent = res.value || "";
        const lines = rawContent.split('\n').map((l: string) => l.trim()).filter((l: string) => l);

        let nodes: string[] = [];
        let fetchPromises = [];

        for (const line of lines) {
            if (line.startsWith('http://') || line.startsWith('https://')) {
                fetchPromises.push(
                    fetch(line, { headers: { 'User-Agent': 'v2rayN/6.0' } })
                        .then(r => r.ok ? r.text() : '')
                        .catch(() => '')
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
            const subNodes = decoded.split('\n').map((l: string) => l.trim()).filter((l: string) => l);
            nodes.push(...subNodes);
        }

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

    } caught (err: any) {
        return new Response("程序运行发生异常: " + (err?.message || String(err)), { 
            status: 500,
            headers: { "content-type": "text/plain;charset=utf-8" }
        });
    }
});

function encodeBase64(data: string) {
    const bytes = new TextEncoder().encode(data);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

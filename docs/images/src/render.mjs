// 用法：node render.mjs <html 绝对路径> <输出.png> [视口宽=800] [选择器=#stage|page] [DSF=2] [视口高=900]
// 等页面 window.__done（若页面定义了 __wait）+ document.fonts.ready，再截元素；打印页面报错和文字重叠检查结果
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [file, out, wArg = "800", sel = "#stage", dsfArg = "2", hArg = "900"] = process.argv.slice(2);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9800 + Math.floor(Math.random() * 400);
const udd = path.join(process.env.TEMP || "C:/Windows/Temp", "ra-edge-" + PORT);
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--remote-debugging-port=" + PORT, "--user-data-dir=" + udd, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 60 && !wsUrl; i++) { try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(t => t.type === "page"); if (p) wsUrl = p.webSocketDebuggerUrl; } catch (e) {} await sleep(300); }
const ws = new WebSocket(wsUrl); await new Promise(r => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(d.params.exceptionDetails).slice(0, 400)); else if (d.method === "Runtime.consoleAPICalled") logs.push("LOG " + d.params.args.map(a => a.value).join(" ")); };
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: +wArg, height: +hArg, deviceScaleFactor: +dsfArg, mobile: false });
await send("Page.navigate", { url: "file:///" + file.replace(/\\/g, "/") });
const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
for (let i = 0; i < 100; i++) { await sleep(200); const ok = await ev("document.readyState==='complete' && (!window.__wait || window.__done===true)"); if (ok) break; }
await ev("document.fonts.ready.then(()=>1)");
await sleep(500);
const fontInfo = await ev("JSON.stringify({wk:document.fonts.check('16px \"LXGW WenKai\"','需求树'), ph:document.fonts.check('16px \"Patrick Hand\"','Rules'), loaded:[...document.fonts].filter(f=>f.status==='loaded').length})");
let clip;
if (sel === "page") {
  const d = JSON.parse(await ev("JSON.stringify({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})"));
  clip = { x: 0, y: 0, width: d.w, height: d.h, scale: 1 };
} else {
  const v = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return JSON.stringify({x:b.left+scrollX,y:b.top+scrollY,w:b.width,h:b.height})})()`);
  if (!v) { console.error("没找到", sel); proc.kill(); process.exit(2); }
  const b = JSON.parse(v); clip = { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 };
}
const overlaps = await ev("window.__overlaps ? JSON.stringify(window.__overlaps()) : '[]'");
const shot = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("saved", out, Math.round(clip.width) + "x" + Math.round(clip.height), "fonts", fontInfo, "overlaps", overlaps);
if (logs.length) console.log(logs.join("\n"));
ws.close(); proc.kill(); process.exit(0);

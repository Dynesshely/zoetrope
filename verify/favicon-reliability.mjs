import { spawn } from "node:child_process";
import path from "node:path"; import os from "node:os";
const BIN = "/home/dynesshely/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 19999;
const child = spawn(BIN, ["--no-sandbox","--disable-gpu","--disable-dev-shm-usage",`--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(),"favrel-"+Date.now())}`,"--window-size=1400,900","--ignore-certificate-errors","http://localhost:18095/"],{stdio:["ignore","ignore","ignore"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let t=null; for(let i=0;i<90&&!t;i++){ try{ t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==="page"&&x.webSocketDebuggerUrl);}catch{} if(!t)await sleep(300);}
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener("open",r,{once:true}));
let seq=0; const pend=new Map();
ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pend.delete(id))rej(new Error("t/o"))},30000);});
const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});return r.exceptionDetails?"EXC "+(r.exceptionDetails.exception?.description||r.exceptionDetails.text):r.result.value;};
await send("Runtime.enable");
for(let i=0;i<90;i++){ if(await ev("!!(window.__ZOETROPE&&window.__ZOETROPE.ready)")) break; await sleep(500); }
await sleep(22000);
console.log("页面受 SW 控制:", await ev("!!navigator.serviceWorker.controller"));
console.log(await ev(`(async () => {
  const urls = {
    "douyin /favicon.ico (302)": "https://www.douyin.com/favicon.ico",
    "douyin CDN 直链":           "https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico",
    "bilibili /favicon.ico":     "https://www.bilibili.com/favicon.ico",
  };
  const out = [];
  for (const [name, real] of Object.entries(urls)) {
    const enc = window.__ZOETROPE.encode(real);
    const res = [];
    for (let i = 0; i < 4; i++) {
      try { const r = await fetch(enc, { cache: "no-store" }); res.push(r.status + "/" + (r.headers.get("content-type")||"?").slice(0,20)); }
      catch (e) { res.push("EXC:" + e.message.slice(0, 30)); }
    }
    out.push(name.padEnd(28) + res.join("  "));
  }
  return out.join("\\n");
})()`));
child.kill("SIGKILL"); process.exit(0);

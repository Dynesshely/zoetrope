import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path"; import os from "node:os";
const BIN = "/home/dynesshely/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell";
const PORT = 19995;
const child = spawn(BIN, ["--no-sandbox","--disable-gpu","--disable-dev-shm-usage",`--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(os.tmpdir(),"favprobe-"+Date.now())}`,"--window-size=1400,900","--ignore-certificate-errors","http://localhost:18095/"],{stdio:["ignore","ignore","ignore"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let t=null; for(let i=0;i<90&&!t;i++){ try{ t=(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x=>x.type==="page"&&x.webSocketDebuggerUrl);}catch{} if(!t)await sleep(300);}
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener("open",r,{once:true}));
let seq=0; const pend=new Map();
ws.addEventListener("message",ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}});
const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pend.delete(id))rej(new Error("t/o"))},30000);});
const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});return r.exceptionDetails?"EXC "+(r.exceptionDetails.exception?.description||r.exceptionDetails.text):r.result.value;};
await send("Page.enable"); await send("Runtime.enable");
for(let i=0;i<90;i++){ if(await ev("!!(window.__ZOETROPE&&window.__ZOETROPE.ready)")) break; await sleep(500); }
await sleep(25000);
console.log(await ev(`(async () => {
  const out = {};
  const f = document.getElementById("view-bilibili");
  const d = f.contentDocument;
  const link = d && d.querySelector('link[rel~="icon" i], link[rel="shortcut icon" i]');
  out.docIconRaw = link ? link.getAttribute("href") : null;
  out.docBase = d ? d.baseURI : null;
  out.realUrl = (window.__ZOETROPE && document.getElementById("view-bilibili")) ? null : null;
  const cand = ["https://www.bilibili.com/favicon.ico"];
  if (out.docIconRaw) { try { cand.push(new URL(out.docIconRaw, "https://www.bilibili.com/").href); } catch(e){ out.urlErr = String(e); } }
  out.cand = cand;
  out.encoded = cand.map(u => { try { return window.__ZOETROPE.encode(u); } catch(e){ return "EXC "+e; } });
  out.fetchStatus = [];
  for (const u of out.encoded) {
    try { const r = await fetch(u); out.fetchStatus.push([u.slice(0,60), r.status, r.headers.get("content-type")]); }
    catch (e) { out.fetchStatus.push([u.slice(0,60), "EXC "+e.message]); }
  }
  out.imgLoad = [];
  for (const u of out.encoded) {
    out.imgLoad.push(await new Promise(res => { const i = new Image(); i.onload = () => res([u.slice(0,60), "ok", i.naturalWidth]); i.onerror = () => res([u.slice(0,60), "ERROR"]); i.src = u; setTimeout(()=>res([u.slice(0,60),"timeout"]), 12000); }));
  }
  const fav = document.querySelector('#view-bilibili').closest('.pane').querySelector('.fav');
  out.favNow = fav ? fav.getAttribute("src").slice(0, 80) : null;
  return JSON.stringify(out, null, 1);
})()`));
child.kill("SIGKILL"); process.exit(0);

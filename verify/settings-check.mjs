import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path"; import os from "node:os";
const HUB = process.env.HUB_URL || "http://127.0.0.1:18095/";
const PORT = Number(process.env.CDP_PORT || 19710);
const OUT = process.env.OUT_DIR || path.join(process.cwd(), "verify", "settings");
async function findBrowser(){const r=path.join(os.homedir(),".cache","ms-playwright");
 for(const d of (await readdir(r)).sort().reverse()){if(!d.startsWith("chromium_headless_shell"))continue;
 const p=path.join(r,d,"chrome-headless-shell-linux64","chrome-headless-shell");if(existsSync(p))return p;}throw 0;}
class C{constructor(w){this.w=w;this.i=0;this.p=new Map();w.addEventListener("message",e=>{const m=JSON.parse(e.data);
 if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
 send(m,p={}){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.w.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.delete(id))rej(new Error(m+" timeout"))},20000);});}
 async ev(x){const r=await this.send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return "__EXC__ "+r.exceptionDetails.text;return r.result.value;}
 async shot(f){const r=await this.send("Page.captureScreenshot",{format:"png"});await writeFile(f,Buffer.from(r.data,"base64"));}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(OUT,{recursive:true}); const out={steps:[]}; let child;
try{
 const BIN=await findBrowser(); const prof=path.join(os.tmpdir(),"zt-set-"+Date.now());
 child=spawn(BIN,["--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--remote-debugging-port="+PORT,"--user-data-dir="+prof,"--window-size=1400,950",
  ...(process.env.CHROME_ARGS?process.env.CHROME_ARGS.split(/\s+/).filter(Boolean):[]),HUB],{stdio:["ignore","ignore","ignore"]});
 let t=null; for(let i=0;i<60&&!t;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();t=l.find(x=>x.type==="page"&&x.webSocketDebuggerUrl);}catch{} if(!t)await sleep(500);}
 const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.addEventListener("open",res,{once:true});ws.addEventListener("error",()=>rej(new Error("ws")),{once:true});});
 const cdp=new C(ws); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
 for(let i=0;i<60;i++){if(await cdp.ev("!!(window.__ZOETROPE&&window.__ZOETROPE.ready)"))break;await sleep(1000);}
 await cdp.ev('localStorage.removeItem("zoetrope.sites")');
 // 打开设置
 await cdp.ev('document.getElementById("settings").click()');
 await sleep(800);
 out.rows=await cdp.ev('document.querySelectorAll("#sites .site-row").length');
 out.hidden=await cdp.ev('document.getElementById("settings-modal").hidden');
 out.fields=await cdp.ev('JSON.stringify([...document.querySelectorAll("#sites .site-row")].map(r=>[r.querySelector(\'[data-k="name"]\').value, r.querySelector(\'[data-k="url"]\').value, r.querySelector(\'[data-k="proxied"]\').checked]))');
 out.steps.push("弹窗打开="+(!out.hidden)+" 行数="+out.rows);
 out.steps.push("字段="+out.fields);
 await cdp.shot(path.join(OUT,"settings.png"));
 // 改一个名字 + 添加一行 + 保存
 await cdp.ev(`(()=>{const r=document.querySelectorAll("#sites .site-row")[0];r.querySelector('[data-k="name"]').value="B站";document.getElementById("site-add").click();const rows=document.querySelectorAll("#sites .site-row");const nr=rows[rows.length-1];nr.querySelector('[data-k="name"]').value="测试站";nr.querySelector('[data-k="url"]').value="https://example.com/";return rows.length;})()`);
 await sleep(400);
 await cdp.shot(path.join(OUT,"settings-edited.png"));
 await cdp.ev('document.getElementById("site-save").click()');
 await sleep(6000);
 for(let i=0;i<60;i++){if(await cdp.ev("!!(window.__ZOETROPE&&window.__ZOETROPE.ready)"))break;await sleep(1000);}
 out.afterSave=await cdp.ev('JSON.stringify((window.PLATFORMS||[]).map(p=>[p.id,p.name,p.url||p.urlTemplate,p.proxied]))');
 out.stored=await cdp.ev('localStorage.getItem("zoetrope.sites")');
 out.steps.push("保存后 PLATFORMS="+out.afterSave);
 await cdp.ev('localStorage.removeItem("zoetrope.sites")');
 ws.close();
}catch(e){out.fatal=String(e?.stack||e);}finally{if(child)try{child.kill("SIGKILL")}catch{}}
await writeFile(path.join(OUT,"result.json"),JSON.stringify(out,null,2));
for(const s of out.steps)console.log(s); console.log("fatal:",out.fatal||"-"); process.exit(0);

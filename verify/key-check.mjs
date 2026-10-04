import { spawn } from "node:child_process";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path"; import os from "node:os";
const HUB=process.env.HUB_URL||"http://127.0.0.1:18095/",PORT=Number(process.env.CDP_PORT||19720);
const OUT=process.env.OUT_DIR||path.join(process.cwd(),"verify","keys");
async function fb(){const r=path.join(os.homedir(),".cache","ms-playwright");
 for(const d of (await readdir(r)).sort().reverse()){if(!d.startsWith("chromium_headless_shell"))continue;
 const p=path.join(r,d,"chrome-headless-shell-linux64","chrome-headless-shell");if(existsSync(p))return p;}throw 0;}
class C{constructor(w){this.w=w;this.i=0;this.p=new Map();w.addEventListener("message",e=>{const m=JSON.parse(e.data);
 if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);}});}
 send(m,p={}){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.w.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(this.p.delete(id))rej(new Error(m))},20000);});}
 async ev(x){const r=await this.send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return "__EXC__ "+r.exceptionDetails.text;return r.result.value;}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(OUT,{recursive:true}); const out={steps:[]}; let ch;
try{
 const BIN=await fb(); ch=spawn(BIN,["--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--remote-debugging-port="+PORT,"--user-data-dir="+path.join(os.tmpdir(),"zt-k-"+Date.now()),"--window-size=1300,900",
  ...(process.env.CHROME_ARGS?process.env.CHROME_ARGS.split(/\s+/).filter(Boolean):[]),HUB],{stdio:["ignore","ignore","ignore"]});
 let t=null; for(let i=0;i<60&&!t;i++){try{const l=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();t=l.find(x=>x.type==="page"&&x.webSocketDebuggerUrl);}catch{} if(!t)await sleep(500);}
 const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.addEventListener("open",r,{once:true});ws.addEventListener("error",()=>j(new Error("ws")),{once:true});});
 const cdp=new C(ws); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
 for(let i=0;i<60;i++){if(await cdp.ev("!!(window.__ZOETROPE&&window.__ZOETROPE.ready)"))break;await sleep(1000);}
 await cdp.ev('window.__ZOETROPE.focusView("bilibili")'); await sleep(12000);
 await cdp.ev('document.getElementById("view-bilibili").contentWindow.__MARK=42');
 out.before=await cdp.ev('document.getElementById("view-bilibili").contentWindow.__MARK');
 out.steps.push("打标记 __MARK="+out.before);
 // 焦点放在 hub 上，派发 Ctrl+R
 await cdp.ev('window.focus(); document.body.focus();');
 for(const type of ["keyDown","keyUp"])
   await cdp.send("Input.dispatchKeyEvent",{type,key:"r",code:"KeyR",windowsVirtualKeyCode:82,modifiers:2});
 await sleep(9000);
 out.after=await cdp.ev('document.getElementById("view-bilibili").contentWindow.__MARK');
 out.title=await cdp.ev('document.getElementById("view-bilibili").contentDocument.title');
 out.steps.push("Ctrl+R 之后 __MARK="+out.after+" | 标题="+String(out.title).slice(0,30));
 // 视图内部的 Ctrl+R（注入的那一份）
 await cdp.ev('(()=>{const w=document.getElementById("view-bilibili").contentWindow;w.__MARK2=7;return 1})()');
 await cdp.ev('(()=>{const d=document.getElementById("view-bilibili").contentDocument;d.body.dispatchEvent(new KeyboardEvent("keydown",{key:"r",ctrlKey:true,bubbles:true,cancelable:true}));return 1})()');
 await sleep(9000);
 out.after2=await cdp.ev('document.getElementById("view-bilibili").contentWindow.__MARK2');
 out.steps.push("视图内 Ctrl+R 之后 __MARK2="+out.after2);
 ws.close();
}catch(e){out.fatal=String(e?.stack||e);}finally{if(ch)try{ch.kill("SIGKILL")}catch{}}
await writeFile(path.join(OUT,"result.json"),JSON.stringify(out,null,2));
for(const s of out.steps)console.log(s); console.log("fatal:",out.fatal||"-"); process.exit(0);

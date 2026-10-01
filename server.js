const express=require("express");
const QRCode=require("qrcode");
const path=require("path");
const crypto=require("crypto");
const {readPages,createPage,updatePage,deletePage,hydratePage,uploadMedia,migrateLocalIfNeeded,listR2Files,configured,googleConfigured,r2Configured}=require("./storage");

const app=express();
const PORT=process.env.PORT||3000;

const deviceToken=q=>String(q.get("x-device-token")||"").trim().slice(0,160);
const validDeviceToken=t=>/^[A-Za-z0-9_-]{24,160}$/.test(t);
const publicPage=p=>{if(!p)return p;const x={...p};delete x.ownerToken;return x;};
const requireOwner=(p,q,s)=>{
  const t=deviceToken(q);
  if(!p||!validDeviceToken(t)||p.ownerToken!==t){s.status(403).json({error:"This WishingStar belongs to another device."});return false;}
  return true;
};

app.use(express.json({limit:"70mb"}));
app.use(express.static(path.join(__dirname,"public"),{
  setHeaders:(res,filePath)=>{
    if(filePath.endsWith("index.html")||filePath.endsWith(".js")){
      res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    }
  }
}));

const safeMedia=v=>{
  if(typeof v!=="string"||v.length>21000000)return "";
  if(v.startsWith("data:")){
    const comma=v.indexOf(",");
    if(comma<0)return "";
    const h=v.slice(0,comma).toLowerCase();
    if(!(h.startsWith("data:image/")||h.startsWith("data:video/")||h.startsWith("data:audio/")))return "";
    const body=v.slice(comma+1);
    return new RegExp("^[A-Za-z0-9+/=\\r\\n]+$").test(body)?v:"";
  }
  try{
    const u=new URL(v);
    const base=String(process.env.R2_PUBLIC_BASE_URL||"").replace(/\/$/,"");
    return base&&v.startsWith(base+"/")?v:"";
  }catch{return ""}
};

const clean=b=>({
  type:["birthday","proposal","valentine","anniversary","custom"].includes(b?.type)?b.type:"birthday",
  recipient:String(b?.recipient||"").slice(0,80),
  sender:String(b?.sender||"").slice(0,80),
  title:String(b?.title||"").slice(0,140),
  customOccasion:String(b?.customOccasion||"").slice(0,80),
  message:String(b?.message||"").slice(0,6000),
  loveText:String(b?.loveText||"").slice(0,6000),
  date:String(b?.date||"").slice(0,40),
  theme:["rose","lavender","midnight","sunset","classic"].includes(b?.theme)?b.theme:"rose",
  accent:String(b?.accent||"#ff4f81").slice(0,20),
  musicUrl:String(b?.musicUrl||"").slice(0,500),
  proposalQuestion:String(b?.proposalQuestion||"").slice(0,300),
  yesText:String(b?.yesText||"Yes ❤️").slice(0,80),
  noText:String(b?.noText||"Maybe 🙈").slice(0,80),
  photos:Array.isArray(b?.photos)?b.photos.map(safeMedia).filter(Boolean).slice(0,8):[],
  customAudio:safeMedia(b?.customAudio||""),
  videos:Array.isArray(b?.videos)?b.videos.map(safeMedia).filter(Boolean).slice(0,8):[],
  sections:b?.sections&&typeof b.sections==="object"
    ?Object.fromEntries(Object.entries(b.sections)
      .filter(([k,v])=>["love","like","special","adore","favorite","promises"].includes(k)&&typeof v==="string")
      .map(([k,v])=>[k,v.slice(0,4000)])): {},
  dateInvite:b?.dateInvite&&typeof b.dateInvite==="object"
    ?{date:String(b.dateInvite.date||"").slice(0,40),time:String(b.dateInvite.time||"").slice(0,20),place:String(b.dateInvite.place||"").slice(0,200),message:String(b.dateInvite.message||"").slice(0,1000)}
    :null
});

app.get("/api/pages",async(q,s)=>{
  try{
    const t=deviceToken(q);
    if(!validDeviceToken(t))return s.status(403).json({error:"Your device identity is missing. Please refresh the dashboard."});
    const pages=await readPages();
    s.json(Object.values(pages).filter(p=>p.ownerToken===t).map(publicPage).sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))));
  }catch(e){
    console.error("list pages",e);
    s.status(500).json({error:"Unable to load your WishingStars right now."});
  }
});

app.post("/api/media",async(q,s)=>{
  try{
    if(!validDeviceToken(deviceToken(q)))return s.status(403).json({error:"Your device identity is missing. Please refresh and try again."});
    if(!r2Configured)return s.status(503).json({error:"Cloudflare R2 storage is not configured yet."});
    const v=q.body?.data;
    const folder=["photos","videos","audio"].includes(q.body?.folder)?q.body.folder:"other";
    if(typeof v!=="string"||!v.startsWith("data:"))return s.status(400).json({error:"Invalid media file."});
    const url=await uploadMedia(v,folder,crypto.randomBytes(7).toString("base64url"));
    s.status(201).json({url});
  }catch(e){console.error("media upload",e);s.status(500).json({error:"Could not upload media. Please try again."});}
});

app.post("/api/pages",async(q,s)=>{
  try{
    const t=deviceToken(q);
    if(!validDeviceToken(t))return s.status(403).json({error:"Your device identity is missing. Please refresh and try again."});
    const id=crypto.randomBytes(7).toString("base64url");
    const now=new Date().toISOString();
    const p=await hydratePage(clean(q.body));
    await createPage({...p,id,ownerToken:t,createdAt:now,updatedAt:now});
    s.status(201).json({id,url:q.protocol+"://"+q.get("host")+"/s/"+id});
  }catch(e){
    console.error("create page",e);
    s.status(500).json({error:"Could not save your surprise. Please try again."});
  }
});

app.post("/api/pages/:id/responses",async(q,s)=>{
  try{
    const d=await readPages(),p=d[q.params.id];
    if(!p)return s.status(404).json({error:"Not found"});
    const type=["proposal","date_night","private_message"].includes(q.body?.type)?q.body.type:"private_message";
    const value=String(q.body?.value||"").trim().slice(0,2000);
    const label=String(q.body?.label||"").slice(0,100);
    const name=String(q.body?.name||"").trim().slice(0,80);
    if(!value)return s.status(400).json({error:"Message is empty"});
    const responses=Array.isArray(p.responses)?p.responses:[];
    responses.push({id:crypto.randomBytes(7).toString("base64url"),type,value,label,name,createdAt:new Date().toISOString()});
    const updated={...p,responses:responses.slice(-200),updatedAt:new Date().toISOString()};
    const saved=await updatePage(q.params.id,updated);
    if(!saved)return s.status(404).json({error:"Not found"});
    s.status(201).json({ok:true});
  }catch(e){console.error("recipient response",e);s.status(500).json({error:"Could not save the response."});}
});

app.get("/api/pages/:id",async(q,s)=>{
  try{
    const d=await readPages();
    const p=d[q.params.id];
    p?s.json(publicPage(p)):s.status(404).json({error:"Not found"});
  }catch(e){
    console.error("get page",e);
    s.status(500).json({error:"Storage unavailable"});
  }
});

app.put("/api/pages/:id",async(q,s)=>{
  try{
    const d=await readPages();
    const old=d[q.params.id];
    if(!old)return s.status(404).json({error:"Not found"});
    if(!requireOwner(old,q,s))return;
    const p=await hydratePage(clean(q.body));
    const updated={...p,id:q.params.id,ownerToken:old.ownerToken,createdAt:old.createdAt,updatedAt:new Date().toISOString()};
    const saved=await updatePage(q.params.id,updated,q.get("if-unmodified-since")||null);
    if(saved)s.json(saved);
    else s.status(q.get("if-unmodified-since")?409:404).json({error:q.get("if-unmodified-since")?"This WishingStar was changed in another tab. Reload it before saving again.":"Not found"});
  }catch(e){
    console.error("update page",e);
    s.status(500).json({error:"Could not save your changes. Please try again."});
  }
});

app.delete("/api/pages/:id",async(q,s)=>{
  try{
    const d=await readPages(),p=d[q.params.id];
    if(!p)return s.status(404).json({error:"Not found"});
    if(!requireOwner(p,q,s))return;
    const ok=await deletePage(q.params.id);
    ok?s.json({ok:true}):s.status(404).json({error:"Not found"});
  }catch(e){
    console.error("delete page",e);
    s.status(500).json({error:"Could not delete this surprise. Please try again."});
  }
});

app.get("/api/pages/:id/qr",async(q,s)=>{
  try{
    if(!(await readPages())[q.params.id])return s.status(404).end();
    const url=q.protocol+"://"+q.get("host")+"/s/"+q.params.id;
    s.type("png").send(await QRCode.toBuffer(url,{width:900,margin:2,errorCorrectionLevel:"H",color:{dark:"#7f1d3d",light:"#ffffff"}}));
  }catch(e){
    console.error("qr",e);
    s.status(500).end();
  }
});

app.get("/api/pages/:id/qr-card",async(q,s)=>{
  try{
    if(!(await readPages())[q.params.id])return s.status(404).end();
    const url=q.protocol+"://"+q.get("host")+"/s/"+q.params.id;
    const qrData=await QRCode.toDataURL(url,{width:900,margin:2,errorCorrectionLevel:"H",color:{dark:"#7f1d3d",light:"#ffffff"}});
    s.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>WishingStar QR ♡</title><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=DM+Sans:wght@500;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:10px;background:radial-gradient(circle at 15% 10%,#fff 0 12%,transparent 30%),radial-gradient(circle at 90% 85%,#ffd6e6 0 12%,transparent 35%),linear-gradient(145deg,#fff7fb,#ffd9e8);font-family:"DM Sans",sans-serif;color:#63233e;overflow:auto}.spark{position:fixed;font-size:24px;animation:float 4s ease-in-out infinite}.s1{left:8%;top:13%}.s2{right:9%;top:19%;animation-delay:1s}.s3{left:12%;bottom:14%;animation-delay:2s}.s4{right:12%;bottom:10%;animation-delay:.5s}@keyframes float{50%{transform:translateY(-10px) rotate(8deg)}}.card{position:relative;width:min(94vw,500px);height:min(calc(100dvh - 20px),1350px);max-height:calc(100dvh - 20px);padding:20px 16px 16px;text-align:center;background:rgba(255,255,255,.96);border:2px solid #ffd0df;border-radius:30px;box-shadow:0 24px 70px rgba(127,29,61,.18);overflow:auto}.qr{display:block;width:min(58vw,300px,calc(100vw - 110px),calc(100dvh - 560px));max-width:100%;height:auto;border-radius:12px;margin:auto}.qr-actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:14px}.qr-actions button{border:0;border-radius:999px;padding:11px 18px;background:#ff4f81;color:#fff;font:700 14px "DM Sans",sans-serif;box-shadow:0 8px 20px rgba(127,29,61,.12)}.qr-actions button:last-child{background:#ffe4ee;color:#a62f5c}
@media(prefers-color-scheme:dark){body{background:radial-gradient(circle at 15% 10%,#34202a 0 12%,transparent 30%),radial-gradient(circle at 90% 85%,#30233e 0 12%,transparent 35%),linear-gradient(145deg,#120d12,#21151d);color:#f8eaf0}.card{background:#1c1519f5;border-color:#4b3540;box-shadow:0 24px 70px #0009}.sub,.hint{color:#c7afb9}.qr-wrap{background:#fff;border-color:#75485b}.scan,.title{color:#ff9fbe}.qr-actions button:last-child{background:#39202d;color:#ffb0c8}.qr-actions button{box-shadow:none}}@media(max-height:760px){.card{padding:12px 10px}.title{font-size:30px}.sub{margin-bottom:7px}.qr{width:min(48vw,240px,calc(100vw - 100px),calc(100dvh - 500px))}.scan{font-size:27px;margin:6px 0 1px}.hint{font-size:11px}.stickers{margin-top:6px}.qr-actions{margin-top:7px}}.ribbon{font-size:25px;letter-spacing:4px;margin-bottom:3px}.title{font:700 36px Caveat,cursive;color:#ff4f81;margin:0}.sub{font-size:14px;color:#9b5a70;margin:2px 0 14px}.qr-wrap{display:inline-block;padding:12px;background:#fff;border:2px solid #f6b8cc;border-radius:26px;box-shadow:0 12px 28px rgba(127,29,61,.12)}.qr{display:block;width:min(58vw,300px,calc(100vw - 110px),calc(100dvh - 560px));max-width:100%;height:auto;border-radius:12px;margin:auto}.scan{font:700 32px Caveat,cursive;color:#a62f5c;margin:12px 0 2px}.hint{font-size:12px;color:#a17d8c}.stickers{margin-top:13px;font-size:24px;letter-spacing:7px}
@media(prefers-color-scheme:dark){.title{color:#ff9fbe}.scan{color:#ff9fbe}.sub,.hint{color:#c7afb9}.qr-wrap{background:#fff;border-color:#75485b}.qr-actions button:last-child{background:#39202d;color:#ffb0c8}}
</style></head><body><span class="spark s1">💗</span><span class="spark s2">✨</span><span class="spark s3">🌸</span><span class="spark s4">🐼</span><main class="card"><div class="ribbon">🎀 💕 🧸 💕 🎀</div><h1 class="title">A little surprise for you ♡</h1><div class="sub">Scan this cute little code to open your WishingStar</div><div class="qr-wrap"><img class="qr" src="${qrData}" alt="WishingStar QR"></div><div class="scan">Scan Me &lt;3</div><div class="hint">Here’s a tiny surprise made with love just for you 💗</div><div class="stickers">🐱 💖 🌷 🐼 ✨ 🎀</div><div class="qr-actions"><button id="qrSave" type="button">Save QR Card</button><button id="qrShare" type="button">Share QR Card</button></div></main><script>const qrImg=document.querySelector(".qr");async function makeQRCard(){const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d"),dpr=Math.min(devicePixelRatio||1,2);canvas.width=1080*dpr;canvas.height=1350*dpr;ctx.scale(dpr,dpr);const W=1080,H=1350;ctx.fillStyle="#fff0f7";ctx.fillRect(0,0,W,H);const g=ctx.createLinearGradient(0,0,W,H);g.addColorStop(0,"#fff7fb");g.addColorStop(1,"#ffd9e8");ctx.fillStyle=g;ctx.fillRect(0,0,W,H);ctx.fillStyle="#fff";ctx.strokeStyle="#ffd0df";ctx.lineWidth=5;roundRect(ctx,70,70,940,1210,55);ctx.fill();ctx.stroke();ctx.textAlign="center";ctx.fillStyle="#ff4f81";ctx.font="700 62px sans-serif";ctx.fillText("🎀  💕  🧸  💕  🎀",540,150);ctx.font="700 76px Caveat, cursive";ctx.fillText("A little surprise for you ♡",540,245);ctx.fillStyle="#9b5a70";ctx.font="500 28px sans-serif";ctx.fillText("Scan this cute little code to open your WishingStar",540,300);const qrSize=690;const qrX=(W-qrSize)/2;const qrY=345;ctx.fillStyle="#fff";ctx.strokeStyle="#f6b8cc";ctx.lineWidth=5;roundRect(ctx,qrX-24,qrY-24,qrSize+48,qrSize+48,34);ctx.fill();ctx.stroke();await new Promise((res,rej)=>{if(qrImg.complete)res();else{qrImg.onload=res;qrImg.onerror=rej}});ctx.drawImage(qrImg,qrX,qrY,qrSize,qrSize);ctx.fillStyle="#a62f5c";ctx.font="700 62px Caveat, cursive";ctx.fillText("Scan Me <3",540,1125);ctx.fillStyle="#a17d8c";ctx.font="500 24px sans-serif";ctx.fillText("Here’s a tiny surprise made with love just for you 💗",540,1175);ctx.fillText("🐱  💖  🌷  🐼  ✨  🎀",540,1230);return new Promise(r=>canvas.toBlob(r,"image/png",1));}function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.closePath()}async function saveQR(){try{const blob=await makeQRCard();const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="WishingStar-QR-Card.png";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}catch(e){alert("Could not save the QR card. Please try again.")}}async function shareQR(){try{const blob=await makeQRCard();const file=new File([blob],"WishingStar-QR-Card.png",{type:"image/png"});if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]})))await navigator.share({title:"WishingStar QR Card",text:"A little surprise for you ♡",files:[file]});else{const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="WishingStar-QR-Card.png";a.click();alert("Your phone/browser does not support direct image sharing, so the QR card was saved instead.")}}catch(e){if(e.name!=="AbortError")alert("Could not share the QR card. Please try again.")}}document.getElementById("qrSave").onclick=saveQR;document.getElementById("qrShare").onclick=shareQR;</script></main></body></html>`);
  }catch(e){
    console.error("qr card",e);
    s.status(500).end();
  }
});

app.get("/api/r2/files",async(q,s)=>{
  try{
    if(!validDeviceToken(deviceToken(q)))return s.status(403).json({error:"Your device identity is missing."});
    if(!r2Configured)return s.status(503).json({error:"R2 is not configured"});
    s.json({files:await listR2Files()});
  }catch(e){
    console.error("r2 list",e);
    s.status(500).json({error:"Unable to list R2 files"});
  }
});

app.delete("/api/r2/files",async(q,s)=>s.status(405).json({error:"R2 deletion is disabled from the public API"}));

app.get("/api/media-proxy",async(q,s)=>{
  try{
    const target=String(q.query?.url||"");
    const base=String(process.env.R2_PUBLIC_BASE_URL||"").replace(/\/$/,"");
    if(!base||!target.startsWith(base+"/"))return s.status(400).json({error:"Invalid media URL"});
    const r=await fetch(target);
    if(!r.ok)return s.status(r.status).end();
    s.status(200);
    s.setHeader("Content-Type",r.headers.get("content-type")||"application/octet-stream");
    s.setHeader("Cache-Control","private,max-age=3600");
    if(String(q.query?.download||"") === "1")s.setHeader("Content-Disposition",'attachment; filename="WishingStar-memory"');
    const ab=await r.arrayBuffer();
    s.send(Buffer.from(ab));
  }catch(e){console.error("media proxy",e);s.status(500).end();}
});

app.get("/s/:id",(q,s)=>s.sendFile(path.join(__dirname,"public/surprise.html")));

app.listen(PORT,async()=>{
  console.log("WishingStar v4 on "+PORT);
  console.log("Storage: Google Drive="+googleConfigured+" Cloudflare R2="+r2Configured+" combined="+configured);
  try{await migrateLocalIfNeeded()}catch(e){console.error("storage migration",e)}
});

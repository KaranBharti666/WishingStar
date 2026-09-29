const express=require("express");
const QRCode=require("qrcode");
const path=require("path");
const crypto=require("crypto");
const {readPages,createPage,updatePage,deletePage,hydratePage,uploadMedia,migrateLocalIfNeeded,listR2Files,configured,googleConfigured,r2Configured}=require("./storage");

const app=express();
const PORT=process.env.PORT||3000;

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
    const pages=await readPages();
    s.json(Object.values(pages).sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||""))));
  }catch(e){
    console.error("list pages",e);
    s.status(500).json({error:"Unable to load your WishingStars right now."});
  }
});

app.post("/api/media",async(q,s)=>{
  try{
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
    const id=crypto.randomBytes(7).toString("base64url");
    const now=new Date().toISOString();
    const p=await hydratePage(clean(q.body));
    await createPage({...p,id,createdAt:now,updatedAt:now});
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
    p?s.json(p):s.status(404).json({error:"Not found"});
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
    const p=await hydratePage(clean(q.body));
    const updated={...p,id:q.params.id,createdAt:old.createdAt,updatedAt:new Date().toISOString()};
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
    s.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>WishingStar QR ♡</title><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=DM+Sans:wght@500;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:18px;background:radial-gradient(circle at 15% 10%,#fff 0 12%,transparent 30%),radial-gradient(circle at 90% 85%,#ffd6e6 0 12%,transparent 35%),linear-gradient(145deg,#fff7fb,#ffd9e8);font-family:"DM Sans",sans-serif;color:#63233e;overflow:hidden}.spark{position:fixed;font-size:24px;animation:float 4s ease-in-out infinite}.s1{left:8%;top:13%}.s2{right:9%;top:19%;animation-delay:1s}.s3{left:12%;bottom:14%;animation-delay:2s}.s4{right:12%;bottom:10%;animation-delay:.5s}@keyframes float{50%{transform:translateY(-10px) rotate(8deg)}}.card{position:relative;width:min(94vw,500px);padding:28px 22px 25px;text-align:center;background:rgba(255,255,255,.96);border:2px solid #ffd0df;border-radius:34px;box-shadow:0 24px 70px rgba(127,29,61,.18)}.ribbon{font-size:25px;letter-spacing:4px;margin-bottom:3px}.title{font:700 36px Caveat,cursive;color:#ff4f81;margin:0}.sub{font-size:14px;color:#9b5a70;margin:2px 0 14px}.qr-wrap{display:inline-block;padding:12px;background:#fff;border:2px solid #f6b8cc;border-radius:26px;box-shadow:0 12px 28px rgba(127,29,61,.12)}.qr{display:block;width:min(70vw,350px);height:auto;border-radius:15px}.scan{font:700 32px Caveat,cursive;color:#a62f5c;margin:12px 0 2px}.hint{font-size:12px;color:#a17d8c}.stickers{margin-top:13px;font-size:24px;letter-spacing:7px}</style></head><body><span class="spark s1">💗</span><span class="spark s2">✨</span><span class="spark s3">🌸</span><span class="spark s4">🐼</span><main class="card"><div class="ribbon">🎀 💕 🧸 💕 🎀</div><h1 class="title">A little surprise for you ♡</h1><div class="sub">Scan this cute little code to open your WishingStar</div><div class="qr-wrap"><img class="qr" src="${qrData}" alt="WishingStar QR"></div><div class="scan">Scan Me &lt;3</div><div class="hint">Here’s a tiny surprise made with love just for you 💗</div><div class="stickers">🐱 💖 🌷 🐼 ✨ 🎀</div></main></body></html>`);
  }catch(e){
    console.error("qr card",e);
    s.status(500).end();
  }
});

app.get("/api/r2/files",async(q,s)=>{
  try{
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

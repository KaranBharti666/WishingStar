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
  videos:Array.isArray(b?.videos)?b.videos.map(safeMedia).filter(Boolean).slice(0,3):[],
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
    s.type("html").send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cute QR Card ♡</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#fff0f5,#ffd6e5);font-family:Arial,sans-serif;padding:18px;box-sizing:border-box}.card{width:min(92vw,520px);background:#fff;border-radius:28px;padding:28px 20px;text-align:center;box-shadow:0 20px 60px #7f1d3d22}.qr{width:min(78vw,390px);border:8px solid #fff;border-radius:20px}.title{font:700 30px Georgia;color:#6f1836;margin:5px}.sub{font-size:17px;color:#9b4560;margin:8px 0 18px}.scan{font:700 28px cursive;color:#7f1d3d;margin:18px}.hint{color:#9b7884;font-size:14px}</style></head><body><main class="card"><div class="title">A little surprise ♡</div><div class="sub">Scan me to open your WishingStar</div><img class="qr" src="/api/pages/'+q.params.id+'/qr" alt="WishingStar QR"><div class="scan">Scan Me &lt;3</div><div class="hint">Here is a cute surprise for you!</div></main></body></html>');
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

app.get("/s/:id",(q,s)=>s.sendFile(path.join(__dirname,"public/surprise.html")));

app.listen(PORT,async()=>{
  console.log("WishingStar v4 on "+PORT);
  console.log("Storage: Google Drive="+googleConfigured+" Cloudflare R2="+r2Configured+" combined="+configured);
  try{await migrateLocalIfNeeded()}catch(e){console.error("storage migration",e)}
});

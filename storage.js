const fs=require("fs"),path=require("path"),crypto=require("crypto");
const {google}=require("googleapis");
const {S3Client,PutObjectCommand}=require("@aws-sdk/client-s3");

const LOCAL_DB=path.join(__dirname,"data/pages.json");
const GOOGLE_READY=!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_REFRESH_TOKEN);
const R2_READY=!!(process.env.R2_ACCOUNT_ID&&process.env.R2_ACCESS_KEY_ID&&process.env.R2_SECRET_ACCESS_KEY&&process.env.R2_BUCKET&&process.env.R2_PUBLIC_BASE_URL);
const READY=GOOGLE_READY&&R2_READY;

let driveFileId=null,drivePromise=null;

function localRead(){fs.mkdirSync(path.dirname(LOCAL_DB),{recursive:true});if(!fs.existsSync(LOCAL_DB))fs.writeFileSync(LOCAL_DB,"{}");return JSON.parse(fs.readFileSync(LOCAL_DB,"utf8"))}
function localWrite(x){fs.mkdirSync(path.dirname(LOCAL_DB),{recursive:true});fs.writeFileSync(LOCAL_DB,JSON.stringify(x,null,2))}

async function getDrive(){
 if(!GOOGLE_READY) return null;
 if(drivePromise)return drivePromise;
 drivePromise=(async()=>{
   const auth=new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET);
   auth.setCredentials({refresh_token:process.env.GOOGLE_REFRESH_TOKEN});
   return google.drive({version:"v3",auth});
 })();
 return drivePromise;
}
async function findDriveFile(){
 const drive=await getDrive(); if(!drive)return null;
 if(driveFileId)return driveFileId;
 const r=await drive.files.list({q:"name='wishingstar-pages.json' and trashed=false",spaces:"appDataFolder",pageSize:1,fields:"files(id,name)"});
 driveFileId=r.data.files?.[0]?.id||null; return driveFileId;
}
async function driveRead(){
 const drive=await getDrive();if(!drive)return null;
 const id=await findDriveFile();if(!id)return {};
 const r=await drive.files.get({fileId:id,alt:"media"});
 return r.data||{};
}
async function driveWrite(data){
 const drive=await getDrive();if(!drive)return;
 const id=await findDriveFile();
 const body=JSON.stringify(data,null,2);
 if(id) await drive.files.update({fileId:id,media:{mimeType:"application/json",body:require("stream").Readable.from([body])}});
 else {
   const r=await drive.files.create({requestBody:{name:"wishingstar-pages.json",parents:["appDataFolder"],mimeType:"application/json"},media:{mimeType:"application/json",body:require("stream").Readable.from([body])},fields:"id"});
   driveFileId=r.data.id;
 }
}
function r2Client(){
 return new S3Client({region:"auto",endpoint:"https://"+process.env.R2_ACCOUNT_ID+".r2.cloudflarestorage.com",credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
}
function dataUrlParts(v){
 const m=String(v||"").match(/^data:([^;,]+)(?:;[^,]+)*;base64,(.+)$/s);
 return m?{mime:m[1],data:Buffer.from(m[2],"base64")}:null;
}
async function uploadDataUrl(v,folder,id){
 if(typeof v!=="string"||!v.startsWith("data:"))return v;
 const p=dataUrlParts(v);if(!p)return v;
 const ext=(p.mime.split("/")[1]||"bin").replace(/[^a-z0-9]+/gi,"").slice(0,10)||"bin";
 const key=folder+"/"+id+"-"+crypto.randomBytes(8).toString("hex")+"."+ext;
 await r2Client().send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:p.data,ContentType:p.mime,CacheControl:"public,max-age=31536000,immutable"}));
 return process.env.R2_PUBLIC_BASE_URL.replace(//$/,"")+"/"+key;
}
async function hydratePage(p){
 const id=p.id||crypto.randomBytes(7).toString("base64url");
 const out={...p,id};
 if(R2_READY){
   out.photos=await Promise.all((p.photos||[]).map(v=>uploadDataUrl(v,"photos",id)));
   out.videos=await Promise.all((p.videos||[]).map(v=>uploadDataUrl(v,"videos",id)));
   if(p.customAudio)out.customAudio=await uploadDataUrl(p.customAudio,"audio",id);
 }
 return out;
}
async function readPages(){
 if(READY)return (await driveRead())||{};
 return localRead();
}
async function writePages(data){
 if(READY)return driveWrite(data);
 return localWrite(data);
}
async function migrateLocalIfNeeded(){
 if(!READY)return;
 const local=localRead();
 if(!Object.keys(local).length)return;
 const remote=await driveRead();
 if(Object.keys(remote||{}).length)return;
 const migrated={};
 for(const [id,p] of Object.entries(local))migrated[id]=await hydratePage(p);
 await driveWrite(migrated);
 console.log("WishingStar storage migration: local pages copied to Google Drive + media to Cloudflare R2");
}
module.exports={readPages,writePages,hydratePage,migrateLocalIfNeeded,configured:READY,googleConfigured:GOOGLE_READY,r2Configured:R2_READY};

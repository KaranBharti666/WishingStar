const fs=require("fs"),path=require("path"),crypto=require("crypto");
const {google}=require("googleapis");
const {S3Client,PutObjectCommand,ListObjectsV2Command,DeleteObjectCommand,GetObjectCommand}=require("@aws-sdk/client-s3");
const {Pool}=require("pg");

const LOCAL_DB=path.join(__dirname,"data/pages.json");
const GOOGLE_READY=!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_REFRESH_TOKEN);
const R2_READY=!!(process.env.R2_ACCOUNT_ID&&process.env.R2_ACCESS_KEY_ID&&process.env.R2_SECRET_ACCESS_KEY&&process.env.R2_BUCKET&&process.env.R2_PUBLIC_BASE_URL);
const DATABASE_READY=!!process.env.DATABASE_URL;

let driveFileId=null,drivePromise=null,dbPromise=null,backupRootId=null,backupFolderIds={};

function localRead(){fs.mkdirSync(path.dirname(LOCAL_DB),{recursive:true});if(!fs.existsSync(LOCAL_DB))fs.writeFileSync(LOCAL_DB,"{}");return JSON.parse(fs.readFileSync(LOCAL_DB,"utf8"))}
function localWrite(x){fs.mkdirSync(path.dirname(LOCAL_DB),{recursive:true});fs.writeFileSync(LOCAL_DB,JSON.stringify(x,null,2))}

async function getDrive(){
 if(!GOOGLE_READY)return null;
 if(drivePromise)return drivePromise;
 drivePromise=(async()=>{
   const auth=new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET);
   auth.setCredentials({refresh_token:process.env.GOOGLE_REFRESH_TOKEN});
   return google.drive({version:"v3",auth});
 })();
 return drivePromise;
}
async function findDriveFile(){
 const drive=await getDrive();if(!drive)return null;
 if(driveFileId)return driveFileId;
 const r=await drive.files.list({q:"name='wishingstar-pages.json' and trashed=false",spaces:"appDataFolder",pageSize:1,fields:"files(id,name)"});
 driveFileId=r.data.files?.[0]?.id||null;return driveFileId;
}
async function driveRead(){
 const drive=await getDrive();if(!drive)return null;
 const id=await findDriveFile();if(!id)return {};
 const r=await drive.files.get({fileId:id,alt:"media"});return r.data||{};
}
async function driveWrite(data){
 const drive=await getDrive();if(!drive)return;
 const id=await findDriveFile(),body=JSON.stringify(data,null,2);
 if(id)await drive.files.update({fileId:id,media:{mimeType:"application/json",body:require("stream").Readable.from([body])}});
 else{
   const r=await drive.files.create({requestBody:{name:"wishingstar-pages.json",parents:["appDataFolder"],mimeType:"application/json"},media:{mimeType:"application/json",body:require("stream").Readable.from([body])},fields:"id"});
   driveFileId=r.data.id;
 }
}
function getDb(){
 if(!DATABASE_READY)return null;
 if(!dbPromise){
   dbPromise=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:5});
 }
 return dbPromise;
}
async function initDatabase(){
 const db=getDb();if(!db)return;
 await db.query(`CREATE TABLE IF NOT EXISTS wishingstar_pages (
   id TEXT PRIMARY KEY,
   data JSONB NOT NULL,
   created_at TIMESTAMPTZ NOT NULL,
   updated_at TIMESTAMPTZ NOT NULL
 )`);
 const count=Number((await db.query("SELECT COUNT(*)::int AS count FROM wishingstar_pages")).rows[0].count);
 if(count===0&&GOOGLE_READY){
   const remote=await driveRead();
   const entries=Object.entries(remote||{});
   for(const [id,p] of entries){
     const createdAt=new Date(p.createdAt||new Date().toISOString());
     const updatedAt=new Date(p.updatedAt||createdAt.toISOString());
     await db.query(
       "INSERT INTO wishingstar_pages (id,data,created_at,updated_at) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (id) DO NOTHING",
       [id,JSON.stringify({...p,id}),createdAt,updatedAt]
     );
   }
   if(entries.length)console.log("WishingStar: migrated existing pages from Google Drive to PostgreSQL");
 }
}
async function ensureDatabase(){if(DATABASE_READY){if(!dbPromise||!dbPromise.__initialized){await initDatabase();if(dbPromise)dbPromise.__initialized=true}}}

async function readDatabase(){
 await ensureDatabase();
 const rows=(await getDb().query("SELECT id,data FROM wishingstar_pages ORDER BY created_at DESC")).rows;
 return Object.fromEntries(rows.map(r=>[r.id,r.data]));
}
async function writeDatabase(data){
 await ensureDatabase();
 const db=getDb(),client=await db.connect();
 try{
   await client.query("BEGIN");
   for(const [id,p] of Object.entries(data)){
     await client.query(
       "INSERT INTO wishingstar_pages (id,data,created_at,updated_at) VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at",
       [id,JSON.stringify({...p,id}),new Date(p.createdAt||new Date().toISOString()),new Date(p.updatedAt||new Date().toISOString())]
     );
   }
   const ids=Object.keys(data);
   if(ids.length)await client.query("DELETE FROM wishingstar_pages WHERE NOT (id = ANY($1::text[]))",[ids]);
   else await client.query("DELETE FROM wishingstar_pages");
   await client.query("COMMIT");
 }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}
async function createPage(p){
 await ensureDatabase();
 if(!DATABASE_READY){const d=await readPages();d[p.id]=p;await writePages(d);return p}
 const db=getDb(),client=await db.connect();
 try{
   await client.query("INSERT INTO wishingstar_pages (id,data,created_at,updated_at) VALUES ($1,$2::jsonb,$3,$4)",
     [p.id,JSON.stringify(p),new Date(p.createdAt),new Date(p.updatedAt)]);
 }finally{client.release()}
 if(GOOGLE_READY){try{await driveWrite(await readDatabase())}catch(e){console.error("Google Drive backup failed",e.message)}}
 return p;
}
async function updatePage(id,p,expectedUpdatedAt=null){
 await ensureDatabase();
 if(!DATABASE_READY){const d=await readPages();if(!d[id])return null;d[id]=p;await writePages(d);return p}
 const db=getDb();
 const r=expectedUpdatedAt
   ? await db.query("UPDATE wishingstar_pages SET data=$2::jsonb,updated_at=$3 WHERE id=$1 AND updated_at=$4 RETURNING data",[id,JSON.stringify(p),new Date(p.updatedAt),new Date(expectedUpdatedAt)])
   : await db.query("UPDATE wishingstar_pages SET data=$2::jsonb,updated_at=$3 WHERE id=$1 RETURNING data",[id,JSON.stringify(p),new Date(p.updatedAt)]);
 if(!r.rowCount)return null;
 if(GOOGLE_READY){try{await driveWrite(await readDatabase())}catch(e){console.error("Google Drive backup failed",e.message)}}
 return r.rows[0].data;
}
async function deletePage(id){
 await ensureDatabase();
 if(!DATABASE_READY){const d=await readPages();if(!d[id])return false;delete d[id];await writePages(d);return true}
 const db=getDb();
 const r=await db.query("DELETE FROM wishingstar_pages WHERE id=$1",[id]);
 if(!r.rowCount)return false;
 if(GOOGLE_READY){try{await driveWrite(await readDatabase())}catch(e){console.error("Google Drive backup failed",e.message)}}
 return true;
}
function r2Client(){
 return new S3Client({region:"auto",endpoint:"https://"+process.env.R2_ACCOUNT_ID+".r2.cloudflarestorage.com",credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
}
function dataUrlParts(v){
 const m=String(v||"").match(/^data:([^;,]+)(?:;[^,]+)*;base64,(.+)$/s);
 return m?{mime:m[1],data:Buffer.from(m[2],"base64")}:null;
}
async function listR2Files(){
 if(!R2_READY)throw new Error("Cloudflare R2 is not configured");
 const files=[];let token;
 do{
   const r=await r2Client().send(new ListObjectsV2Command({Bucket:process.env.R2_BUCKET,ContinuationToken:token,MaxKeys:1000}));
   for(const o of (r.Contents||[])){
     const key=o.Key||"";
     files.push({
       key,
       size:Number(o.Size||0),
       lastModified:o.LastModified||null,
       url:process.env.R2_PUBLIC_BASE_URL.replace(/\/$/,"")+"/"+key.split("/").map(encodeURIComponent).join("/")
     });
   }
   token=r.NextContinuationToken;
 }while(token);
 return files;
}
async function getOrCreateDriveFolder(name,parentId=null){
 const drive=await getDrive();if(!drive)throw new Error("Google Drive is not configured");
 const escaped=name.replace(/\\/g,"\\\\").replace(/'/g,"\\'");
 const parentQuery=parentId ? " and '"+parentId+"' in parents" : " and 'root' in parents";
 const q="name='"+escaped+"' and mimeType='application/vnd.google-apps.folder' and trashed=false"+parentQuery;
 const found=await drive.files.list({q,spaces:"drive",pageSize:1,fields:"files(id,name)"});
 if(found.data.files?.[0])return found.data.files[0].id;
 const r=await drive.files.create({requestBody:{name,mimeType:"application/vnd.google-apps.folder",parents:parentId?[parentId]:["root"]},fields:"id"});
 return r.data.id;
}
async function backupR2ToGoogleDrive({olderThanDays=30,dryRun=false}={}){
 if(!R2_READY)throw new Error("Cloudflare R2 is not configured");
 if(!GOOGLE_READY)throw new Error("Google Drive is not configured");
 const drive=await getDrive();
 if(!backupRootId)backupRootId=await getOrCreateDriveFolder("WishingStar Backups");
 const cutoff=Date.now()-olderThanDays*24*60*60*1000;
 const files=await listR2Files();
 const old=files.filter(f=>f.lastModified&&new Date(f.lastModified).getTime()<=cutoff);
 const stats={checked:files.length,eligible:old.length,backedUp:0,deleted:0,failed:0,errors:[]};
 for(const f of old){
   try{
     const folderName=f.key.startsWith("photos/")?"photos":f.key.startsWith("videos/")?"videos":f.key.startsWith("audio/")?"audio":"other";
     if(!backupFolderIds[folderName])backupFolderIds[folderName]=await getOrCreateDriveFolder(folderName,backupRootId);
     const folderId=backupFolderIds[folderName];
     const fileName=f.key.split("/").pop()||"backup-file";
     const safeName=fileName.replace(/[\\/:*?"<>|]/g,"_");
     const escapedFile=safeName.replace(/\\/g,"\\\\").replace(/'/g,"\\'");
     const q="name='"+escapedFile+"' and '"+folderId+"' in parents and trashed=false";
     const existing=await drive.files.list({q,spaces:"drive",pageSize:20,fields:"files(id,name,description)"});
     const isOurBackup=existing.data.files?.some(x=>x.description==="WishingStar R2 backup: "+f.key);
     if(!isOurBackup){
       const obj=await r2Client().send(new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:f.key}));
       await drive.files.create({
         requestBody:{name:safeName,parents:[folderId],description:"WishingStar R2 backup: "+f.key},
         media:{mimeType:obj.ContentType||"application/octet-stream",body:obj.Body},
         fields:"id,name"
       });
     }
     stats.backedUp++;
     if(!dryRun){await deleteR2File(f.key);stats.deleted++;}
   }catch(e){
     stats.failed++;stats.errors.push({key:f.key,error:e.message});
     console.error("R2 backup failed",f.key,e.message);
   }
 }
 return stats;
}

async function deleteR2File(key){
 if(!R2_READY)throw new Error("Cloudflare R2 is not configured");
 if(typeof key!=="string"||!key||key.includes("..")||key.startsWith("/"))throw new Error("Invalid R2 key");
 await r2Client().send(new DeleteObjectCommand({Bucket:process.env.R2_BUCKET,Key:key}));
}
async function uploadDataUrl(v,folder,id){
 if(typeof v!=="string"||!v.startsWith("data:"))return v;
 const p=dataUrlParts(v);if(!p)return v;
 const ext=(p.mime.split("/")[1]||"bin").replace(/[^a-z0-9]+/gi,"").slice(0,10)||"bin";
 const key=folder+"/"+id+"-"+crypto.randomBytes(8).toString("hex")+"."+ext;
 await r2Client().send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:p.data,ContentType:p.mime,CacheControl:"public,max-age=31536000,immutable"}));
 return process.env.R2_PUBLIC_BASE_URL.replace(/\/$/,"")+"/"+key;
}
async function hydratePage(p){
 const id=p.id||crypto.randomBytes(7).toString("base64url"),out={...p,id};
 if(R2_READY){
   out.photos=await Promise.all((p.photos||[]).map(v=>uploadDataUrl(v,"photos",id)));
   out.videos=await Promise.all((p.videos||[]).map(v=>uploadDataUrl(v,"videos",id)));
   if(p.customAudio)out.customAudio=await uploadDataUrl(p.customAudio,"audio",id);
 }
 return out;
}
async function readPages(){
 if(DATABASE_READY)return readDatabase();
 if(GOOGLE_READY)return (await driveRead())||{};
 return localRead();
}
async function writePages(data){
 if(DATABASE_READY){
   await writeDatabase(data);
   if(GOOGLE_READY){try{await driveWrite(data)}catch(e){console.error("Google Drive backup failed",e.message)}}
   return;
 }
 if(GOOGLE_READY)return driveWrite(data);
 return localWrite(data);
}
async function migrateLocalIfNeeded(){
 if(DATABASE_READY){await ensureDatabase();return}
 if(!GOOGLE_READY)return;
 const local=localRead();
 if(!Object.keys(local).length)return;
 const remote=await driveRead();
 if(Object.keys(remote||{}).length)return;
 const migrated={};
 for(const [id,p] of Object.entries(local))migrated[id]=await hydratePage(p);
 await driveWrite(migrated);
 console.log("WishingStar storage migration: local pages copied to Google Drive + media to Cloudflare R2");
}
module.exports={readPages,writePages,createPage,updatePage,deletePage,hydratePage,migrateLocalIfNeeded,listR2Files,deleteR2File,backupR2ToGoogleDrive,configured:DATABASE_READY||GOOGLE_READY,googleConfigured:GOOGLE_READY,r2Configured:R2_READY};

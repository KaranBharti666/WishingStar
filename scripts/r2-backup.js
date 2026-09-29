const {backupR2ToGoogleDrive}=require("../storage");

(async()=>{
  try{
    const result=await backupR2ToGoogleDrive({olderThanDays:30});
    console.log("=== WishingStar R2 BACKUP RESULT ===");
    console.log(JSON.stringify(result,null,2));
    console.log(`Checked: ${result.checked}, Eligible: ${result.eligible}, Backed up: ${result.backedUp}, Deleted: ${result.deleted}, Failed: ${result.failed}`);
    if(result.errors?.length){
      console.error("=== BACKUP ERRORS ===");
      for(const item of result.errors) console.error(`[${item.key}] ${item.error}`);
    }
    if(result.failed>0) process.exitCode=1;
  }catch(error){
    console.error("=== FATAL WishingStar R2 backup error ===");
    console.error(error?.stack||error?.message||error);
    process.exitCode=1;
  }
})();

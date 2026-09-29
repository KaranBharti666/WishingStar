const {backupR2ToGoogleDrive}=require("../storage");

backupR2ToGoogleDrive({olderThanDays:30})
  .then(result=>{
    console.log("WishingStar R2 backup complete:",JSON.stringify(result));
    if(result.failed>0)process.exitCode=1;
  })
  .catch(error=>{
    console.error("WishingStar R2 backup failed:",error);
    process.exitCode=1;
  });

const express=require("express");
const multer=require("multer");
const crypto=require("crypto");
const fs=require("fs");
const {TwitterApi}=require("twitter-api-v2");
const app=express(),upload=multer({dest:"/tmp",limits:{fileSize:512*1024*1024}});
app.use(express.urlencoded({extended:true}));
const flows=new Map(); let client=null, accessToken="";
const BASE=(process.env.BASE_URL||"").replace(/\/$/,"");
app.get("/",(_,res)=>res.send(`<!doctype html><meta name="viewport" content="width=device-width"><title>X Publisher</title><style>body{font-family:sans-serif;max-width:650px;margin:40px auto;padding:20px}button,input,textarea{font-size:18px;margin:8px 0;padding:12px;width:100%;box-sizing:border-box}button{background:#111;color:#fff;border:0;border-radius:10px}</style><h1>X Publisher</h1><p>동영상 업로드 → X 게시</p><a href="/login"><button>X 계정 연결</button></a><form action="/post" method="post" enctype="multipart/form-data"><input type="file" name="video" accept="video/*" required><textarea name="text" rows="5" maxlength="280" placeholder="게시 문구"></textarea><button>동영상 X에 게시</button></form>`));
app.get("/login",(_,res)=>{try{const c=new TwitterApi({clientId:process.env.X_CLIENT_ID,clientSecret:process.env.X_CLIENT_SECRET});const state=crypto.randomBytes(24).toString("hex");const x=c.generateOAuth2AuthLink(BASE+"/callback",{scope:["tweet.read","tweet.write","users.read","offline.access"],state});flows.set(state,{verifier:x.codeVerifier,at:Date.now()});res.redirect(x.url)}catch(e){res.status(500).send("X 로그인 시작 실패: "+e.message)}});
app.get("/callback",async(req,res)=>{try{if(req.query.error)return res.status(400).send("X 승인 실패: "+req.query.error);const flow=flows.get(req.query.state);if(!flow)return res.status(400).send("로그인 세션이 만료되었습니다. X 계정 연결을 다시 눌러주세요.");flows.delete(req.query.state);const c=new TwitterApi({clientId:process.env.X_CLIENT_ID,clientSecret:process.env.X_CLIENT_SECRET});const x=await c.loginWithOAuth2({code:String(req.query.code||""),codeVerifier:flow.verifier,redirectUri:BASE+"/callback"});client=x.client;accessToken=x.accessToken;res.redirect("/?connected=1")}catch(e){console.error("oauth callback",e?.data||e);res.status(500).send("X 연결 실패: "+(e?.data?.detail||e?.data?.title||e.message))}});
async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{Authorization:"Bearer "+accessToken,...(opt.headers||{})}});const t=await r.text();let j={};try{j=t?JSON.parse(t):{}}catch{j={raw:t}}if(!r.ok){console.error("X API",r.status,url,j);throw new Error("X API "+r.status+": "+JSON.stringify(j))}return j}
app.post("/post",upload.single("video"),async(req,res)=>{let path=req.file?.path;try{if(!client)return res.status(401).send("먼저 X 계정을 연결하세요.");if(!req.file)return res.status(400).send("동영상을 선택하세요.");
 const buf=fs.readFileSync(path);
 const init=await api("https://api.x.com/2/media/upload/initialize",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({total_bytes:buf.length,media_type:req.file.mimetype||"video/mp4",media_category:"tweet_video"})});
 const id=String(init.data?.id||init.data?.media_id||init.media_id_string||init.media_id); if(!id||id==="undefined")throw new Error("미디어 ID를 받지 못했습니다: "+JSON.stringify(init));
 const chunk=4*1024*1024;
 for(let off=0,seg=0;off<buf.length;off+=chunk,seg++){
   const form=new FormData(); form.append("segment_index",String(seg)); form.append("media",new Blob([buf.subarray(off,Math.min(off+chunk,buf.length))],{type:req.file.mimetype||"video/mp4"}),"chunk");
   await api("https://api.x.com/2/media/upload/"+id+"/append",{method:"POST",body:form});
 }
 let fin=await api("https://api.x.com/2/media/upload/"+id+"/finalize",{method:"POST"});
 let pi=fin.data?.processing_info;
 for(let n=0;n<60 && pi && pi.state!=="succeeded";n++){
   if(pi.state==="failed")throw new Error("X media processing failed: "+JSON.stringify(pi));
   await new Promise(r=>setTimeout(r,Math.max(1,pi.check_after_secs||2)*1000));
   const st=await api("https://api.x.com/2/media/upload?command=STATUS&media_id="+encodeURIComponent(id));
   pi=st.data?.processing_info;
 }
 const out=await client.v2.tweet({text:req.body.text||"",media:{media_ids:[id]}});
 res.send(`게시 완료<br><a href="https://x.com/i/web/status/${out.data.id}">X 게시물 열기</a>`);
}catch(e){console.error("post failed",e?.data||e);res.status(500).send("게시 실패: "+(e?.data?.detail||e.message))}finally{if(path)fs.unlink(path,()=>{})}});
app.get("/health",(_,r)=>r.send("ok"));app.listen(process.env.PORT||8080,()=>console.log("X Publisher running"));
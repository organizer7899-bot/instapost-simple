import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

fs.mkdirSync("uploads", { recursive: true });

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 1024 * 1024 * 500 }
});

app.use("/uploads", express.static("uploads"));

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InstaPost Simple</title>
<style>
body{
  margin:0;
  background:#111;
  color:#fff;
  font-family:Arial,sans-serif
}
main{
  max-width:560px;
  margin:auto;
  padding:25px 16px
}
h1{font-size:28px}
.card{
  background:#1d1d1d;
  border-radius:18px;
  padding:20px;
  margin:16px 0
}
input,textarea,button{
  width:100%;
  box-sizing:border-box;
  margin-top:12px
}
input,textarea{
  padding:14px;
  border-radius:12px;
  border:1px solid #444;
  background:#111;
  color:#fff;
  font-size:16px
}
textarea{height:150px}
button{
  padding:16px;
  border:0;
  border-radius:14px;
  background:#fff;
  color:#111;
  font-size:17px;
  font-weight:bold
}
video{
  width:100%;
  margin-top:15px;
  border-radius:12px
}
#result{
  margin-top:15px;
  line-height:1.5
}
</style>
</head>

<body>
<main>

<h1>InstaPost Simple</h1>
<p>영상 선택 → 게시글 입력 → Instagram 게시</p>

<div class="card">

<input
  id="video"
  type="file"
  accept="video/mp4,video/quicktime,video/*"
>

<video id="preview" controls hidden></video>

</div>

<div class="card">

<textarea
  id="caption"
  placeholder="게시글 내용을 입력하세요."
></textarea>

<button id="post">
Instagram에 게시
</button>

<div id="result"></div>

</div>

</main>

<script>

const video = document.getElementById("video");
const preview = document.getElementById("preview");
const result = document.getElementById("result");

video.onchange = () => {

  const file = video.files[0];

  if (!file) return;

  preview.src = URL.createObjectURL(file);
  preview.hidden = false;

};

document.getElementById("post").onclick = async () => {

  const file = video.files[0];

  if (!file) {
    result.textContent = "영상을 먼저 선택하세요.";
    return;
  }

  result.textContent = "Instagram 게시 준비 중...";

  const form = new FormData();

  form.append("video", file);
  form.append(
    "caption",
    document.getElementById("caption").value
  );

  try {

    const response = await fetch(
      "/publish",
      {
        method:"POST",
        body:form
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "게시 실패");
    }

    result.textContent =
      "✅ Instagram 게시 완료";

  } catch(error) {

    result.textContent =
      "❌ " + error.message;

  }

};

</script>

</body>
</html>
`);
});

app.post(
  "/publish",
  upload.single("video"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error:"영상을 선택하세요."
        });
      }

      const token =
        process.env.META_ACCESS_TOKEN;

      const igUserId =
        process.env.IG_USER_ID;

      const publicUrl =
        process.env.PUBLIC_BASE_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN
          ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
          : "");

      if (!token || !igUserId || !publicUrl) {

        return res.status(500).json({
          error:
          "Meta 설정이 아직 완료되지 않았습니다."
        });

      }

      const videoUrl =
        publicUrl.replace(/\/$/,"") +
        "/uploads/" +
        req.file.filename;

      const version =
        process.env.META_API_VERSION || "v26.0";

      const createUrl =
        "https://graph.facebook.com/" +
        version +
        "/" +
        igUserId +
        "/media";

      const body =
        new URLSearchParams();

      body.append("media_type","REELS");
      body.append("video_url",videoUrl);
      body.append(
        "caption",
        req.body.caption || ""
      );
      body.append("share_to_feed","true");
      body.append("access_token",token);

      const createResponse =
        await fetch(
          createUrl,
          {
            method:"POST",
            headers:{
              "Content-Type":
              "application/x-www-form-urlencoded"
            },
            body
          }
        );

      const created =
        await createResponse.json();

      if (!createResponse.ok || !created.id) {

        return res.status(502).json({
          error:
          created?.error?.message ||
          "Instagram 업로드 준비 실패"
        });

      }

      const creationId = created.id;

      let finished = false;

      for (let i=0;i<30;i++) {

        await new Promise(
          resolve =>
          setTimeout(resolve,4000)
        );

        const statusUrl =
          "https://graph.facebook.com/" +
          version +
          "/" +
          creationId +
          "?fields=status_code&access_token=" +
          encodeURIComponent(token);

        const statusResponse =
          await fetch(statusUrl);

        const status =
          await statusResponse.json();

        if (
          status.status_code ===
          "FINISHED"
        ) {
          finished = true;
          break;
        }

        if (
          status.status_code ===
          "ERROR"
        ) {
          return res.status(502).json({
            error:
            "Instagram 영상 처리에 실패했습니다."
          });
        }

      }

      if (!finished) {

        return res.status(504).json({
          error:
          "Instagram 영상 처리가 아직 끝나지 않았습니다."
        });

      }

      const publishUrl =
        "https://graph.facebook.com/" +
        version +
        "/" +
        igUserId +
        "/media_publish";

      const publishBody =
        new URLSearchParams();

      publishBody.append(
        "creation_id",
        creationId
      );

      publishBody.append(
        "access_token",
        token
      );

      const publishResponse =
        await fetch(
          publishUrl,
          {
            method:"POST",
            headers:{
              "Content-Type":
              "application/x-www-form-urlencoded"
            },
            body:publishBody
          }
        );

      const published =
        await publishResponse.json();

      if (!publishResponse.ok) {

        return res.status(502).json({
          error:
          published?.error?.message ||
          "Instagram 게시 실패"
        });

      }

      res.json({
        ok:true,
        mediaId:published.id
      });

    } catch(error) {

      console.error(error);

      res.status(500).json({
        error:error.message
      });

    }

  }
);

app.listen(
  PORT,
  () => console.log(
    "InstaPost Simple running on " + PORT
  )
);

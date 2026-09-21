import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const TOKEN_STORE_PATH =
  process.env.META_TOKEN_STORE_PATH || "data/meta-token.json";

let runtimeMetaToken = process.env.META_ACCESS_TOKEN || "";

function loadStoredMetaToken() {
  try {
    // Never overwrite a freshly configured Railway token with an older
    // token persisted on the service filesystem.
    if (runtimeMetaToken) return;
    if (fs.existsSync(TOKEN_STORE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, "utf8"));
      if (saved?.access_token) runtimeMetaToken = saved.access_token;
    }
  } catch (error) {
    console.error("Saved Meta token load failed:", error);
  }
}

function saveStoredMetaToken(accessToken, expiresAt) {
  try {
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(
      TOKEN_STORE_PATH,
      JSON.stringify({
        access_token: accessToken,
        expires_at: expiresAt || null,
        updated_at: new Date().toISOString()
      })
    );
  } catch (error) {
    console.error("Saved Meta token write failed:", error);
  }
}

async function ensureMetaToken() {
  if (!runtimeMetaToken) {
    loadStoredMetaToken();
  }

  if (!runtimeMetaToken) {
    throw new Error("META_ACCESS_TOKEN이 설정되지 않았습니다.");
  }

  // Instagram Login tokens are validated against graph.instagram.com.
  // Do not use /debug_token on graph.instagram.com for this token type.
  const version = process.env.META_API_VERSION || "v26.0";
  const token = String(runtimeMetaToken).trim();

  try {
    const meUrl =
      "https://graph.instagram.com/" +
      version +
      "/me?fields=id,username&access_token=" +
      encodeURIComponent(token);

    const meResponse = await fetch(meUrl);
    const me = await meResponse.json();

    if (!meResponse.ok || !me?.id) {
      console.error("Instagram access token validation failed:", me);
      return token;
    }

    runtimeMetaToken = token;

    // Instagram Login long-lived tokens can be refreshed with the
    // refresh_access_token endpoint. A freshly-created token may be too
    // new to refresh yet; in that case keep using the current token.
    const refreshUrl =
      "https://graph.instagram.com/" +
      version +
      "/refresh_access_token?grant_type=ig_refresh_token&access_token=" +
      encodeURIComponent(token);

    const refreshResponse = await fetch(refreshUrl);
    const refreshed = await refreshResponse.json();

    if (refreshResponse.ok && refreshed?.access_token) {
      runtimeMetaToken = String(refreshed.access_token).trim();
      const expiresAt = refreshed.expires_in
        ? Math.floor(Date.now() / 1000) + Number(refreshed.expires_in)
        : null;
      saveStoredMetaToken(runtimeMetaToken, expiresAt);
      console.log("Instagram access token refreshed automatically.");
    } else {
      // Refresh can legitimately fail for a newly-issued token.
      console.log("Instagram token refresh not applied:", refreshed);
    }

    return runtimeMetaToken;
  } catch (error) {
    console.error("Instagram token check failed:", error);
    return token;
  }
}

loadStoredMetaToken();

fs.mkdirSync("uploads", { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
      const ext = file.originalname.includes(".")
        ? "." + file.originalname.split(".").pop().toLowerCase()
        : ".mp4";
      cb(null, Date.now() + "-" + Math.random().toString(36).slice(2) + ext);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 500 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("동영상 파일만 업로드할 수 있습니다."));
    }
  }
});

app.use("/uploads", express.static("uploads"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "instapost-simple"
  });
});

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

app.get("/meta-debug", async (req, res) => {
  try {
    const token = await ensureMetaToken();
    const version = process.env.META_API_VERSION || "v26.0";

    const url =
      "https://graph.instagram.com/" +
      version +
      "/me?fields=id,username,account_type&access_token=" +
      encodeURIComponent(token);

    const response = await fetch(url);
    const data = await response.json();

    res.status(response.ok ? 200 : response.status).json({
      ok: response.ok && !!data?.id,
      status: response.status,
      me: data,
      api_host: "graph.instagram.com",
      auth_type: "Instagram API with Instagram Login",
      note: "토큰 자체는 응답에 표시하지 않습니다."
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

      const token = await ensureMetaToken();

      const version =
        process.env.META_API_VERSION || "v26.0";

      const publicUrl =
        process.env.PUBLIC_BASE_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN
          ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
          : "");

      const videoUrl =
        publicUrl.replace(/\/$/, "") +
        "/uploads/" +
        req.file.filename;

      let igUserId = process.env.IG_USER_ID || "";

      if (!igUserId) {
        const meUrl =
          "https://graph.instagram.com/" +
          version +
          "/me?fields=id,username&access_token=" +
          encodeURIComponent(token);
        const meResponse = await fetch(meUrl);
        const me = await meResponse.json();

        if (me?.id) {
          igUserId = me.id;
        }
      }

      if (!igUserId) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(500).json({
          error:
            "Instagram 사용자 ID를 찾지 못했습니다. IG_USER_ID를 Railway Variables에 설정하세요."
        });
      }

      const createUrl =
        "https://graph.instagram.com/" +
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
        fs.rmSync(req.file.path, { force: true });
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
          "https://graph.instagram.com/" +
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
          fs.rmSync(req.file.path, { force: true });
          return res.status(502).json({
            error:
              status?.error?.message ||
              "Instagram 영상 처리에 실패했습니다."
          });
        }

      }

      if (!finished) {

        fs.rmSync(req.file.path, { force: true });
        return res.status(504).json({
          error:
            "Instagram 영상 처리가 아직 끝나지 않았습니다."
        });

      }

      const publishUrl =
        "https://graph.instagram.com/" +
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
        fs.rmSync(req.file.path, { force: true });
        return res.status(502).json({
          error:
            published?.error?.message ||
            "Instagram 게시 실패"
        });
      }

      fs.rmSync(req.file.path, { force: true });

      res.json({
        ok:true,
        mediaId:published.id
      });

    } catch(error) {
      if (req.file?.path) {
        fs.rmSync(req.file.path, { force: true });
      }

      console.error(error);

      res.status(500).json({
        error:error.message || "서버 오류가 발생했습니다."
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

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

  const version = process.env.META_API_VERSION || "v26.0";
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  // App credentials are optional for normal posting, but required for
  // automatic long-lived token renewal.
  if (!appId || !appSecret) {
    return runtimeMetaToken;
  }

  try {
    const debugUrl =
      "https://graph.facebook.com/" +
      version +
      "/debug_token?input_token=" +
      encodeURIComponent(runtimeMetaToken) +
      "&access_token=" +
      encodeURIComponent(appId + "|" + appSecret);

    const debugResponse = await fetch(debugUrl);
    const debug = await debugResponse.json();
    const data = debug?.data;

    if (!debugResponse.ok || !data) {
      console.error("Meta token debug failed:", debug);
      return runtimeMetaToken;
    }

    const expiresAt = Number(data.expires_at || 0);
    const daysLeft = expiresAt
      ? (expiresAt * 1000 - Date.now()) / 86400000
      : Infinity;

    // Renew automatically when the token has 14 days or less remaining.
    if (daysLeft > 14) {
      return runtimeMetaToken;
    }

    const refreshUrl =
      "https://graph.facebook.com/" +
      version +
      "/oauth/access_token?grant_type=fb_exchange_token" +
      "&client_id=" +
      encodeURIComponent(appId) +
      "&client_secret=" +
      encodeURIComponent(appSecret) +
      "&fb_exchange_token=" +
      encodeURIComponent(runtimeMetaToken);

    const refreshResponse = await fetch(refreshUrl);
    const refreshed = await refreshResponse.json();

    if (!refreshResponse.ok || !refreshed?.access_token) {
      console.error("Meta token auto-renew failed:", refreshed);
      if (expiresAt && expiresAt * 1000 <= Date.now()) {
        throw new Error(
          "Meta 액세스 토큰이 만료되었습니다. 최초 1회 새 장기 토큰 연결이 필요합니다."
        );
      }
      return runtimeMetaToken;
    }

    runtimeMetaToken = refreshed.access_token;
    const newExpiresAt =
      refreshed.expires_at ||
      (refreshed.expires_in
        ? Math.floor(Date.now() / 1000) + Number(refreshed.expires_in)
        : null);

    saveStoredMetaToken(runtimeMetaToken, newExpiresAt);
    console.log("Meta access token renewed automatically.");

    return runtimeMetaToken;
  } catch (error) {
    if (error.message.includes("최초 1회")) throw error;
    console.error("Meta token renewal check failed:", error);
    return runtimeMetaToken;
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
    const businessId = process.env.META_BUSINESS_ID || "2117489702486564";

    if (!token) {
      return res.status(500).json({ error: "META_ACCESS_TOKEN이 없습니다." });
    }

    const getJson = async (path) => {
      const url =
        "https://graph.facebook.com/" +
        version +
        path +
        (path.includes("?") ? "&" : "?") +
        "access_token=" +
        encodeURIComponent(token);
      const response = await fetch(url);
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    };

    const me = await getJson("/me?fields=id,name,username");
    const accounts = await getJson(
      "/me/accounts?fields=id,name,instagram_business_account"
    );
    const businessPages = await getJson(
      "/" + businessId + "/client_pages?fields=id,name,instagram_business_account"
    );

    res.json({
      me,
      accounts,
      businessPages,
      note: "토큰은 이 응답에 표시하지 않습니다."
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

      let igUserId =
        process.env.IG_USER_ID || "17841425033449176";

      const publicUrl =
        process.env.PUBLIC_BASE_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN
          ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
          : "");

      if (!token) {
        return res.status(500).json({
          error:
            "META_ACCESS_TOKEN을 Railway Variables에 설정하세요."
        });
      }

      const videoUrl =
        publicUrl.replace(/\/$/,"") +
        "/uploads/" +
        req.file.filename;

      const version =
        process.env.META_API_VERSION || "v26.0";

      if (!igUserId) {
        try {
          const meUrl =
            "https://graph.facebook.com/" +
            version +
            "/me?fields=id,username&access_token=" +
            encodeURIComponent(token);
          const meResponse = await fetch(meUrl);
          const me = await meResponse.json();

          if (me?.username && me?.id) {
            igUserId = me.id;
          }
        } catch (lookupError) {
          console.error("Instagram user lookup failed:", lookupError);
        }
      }

      if (!igUserId) {
        try {
          const accountsUrl =
            "https://graph.facebook.com/" +
            version +
            "/me/accounts?fields=id,name,instagram_business_account&access_token=" +
            encodeURIComponent(token);
          const accountsResponse = await fetch(accountsUrl);
          const accounts = await accountsResponse.json();
          const pageWithInstagram = (accounts.data || []).find(
            page => page.instagram_business_account?.id
          );
          igUserId =
            pageWithInstagram?.instagram_business_account?.id || "";
        } catch (lookupError) {
          console.error("Facebook Page Instagram lookup failed:", lookupError);
        }
      }

      if (!igUserId) {
        try {
          const pageId = process.env.META_PAGE_ID || "126707728983019";
          const pageUrl =
            "https://graph.facebook.com/" +
            version +
            "/" +
            pageId +
            "?fields=id,name,instagram_business_account{id,username}&access_token=" +
            encodeURIComponent(token);
          const pageResponse = await fetch(pageUrl);
          const page = await pageResponse.json();
          if (page?.instagram_business_account?.id) {
            igUserId = page.instagram_business_account.id;
          }
          console.log("Direct Page Instagram lookup:", page);
        } catch (lookupError) {
          console.error("Direct Page Instagram lookup failed:", lookupError);
        }
      }

      if (!igUserId) {
        return res.status(500).json({
          error:
            "Instagram 프로 계정 ID를 자동으로 찾지 못했습니다. IG_USER_ID를 Railway Variables에 추가하세요."
        });
      }

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

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


async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getFacebookConfig() {
  return {
    appId: process.env.FB_APP_ID || process.env.META_APP_ID || "",
    appSecret: process.env.FB_APP_SECRET || process.env.META_APP_SECRET || "",
    redirectUri:
      process.env.FB_REDIRECT_URI ||
      (process.env.PUBLIC_BASE_URL
        ? process.env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/facebook/callback"
        : "https://instapost-simple-production.up.railway.app/facebook/callback"),
    pageId: process.env.FB_PAGE_ID || process.env.META_PAGE_ID || "",
    configId: "1070705949020606"
  };
}

function saveFacebookPageToken(pageToken, pageId) {
  try {
    fs.mkdirSync("data", { recursive: true });
    fs.writeFileSync(
      "data/facebook-page-token.json",
      JSON.stringify({
        access_token: pageToken,
        page_id: pageId || null,
        updated_at: new Date().toISOString()
      })
    );
  } catch (error) {
    console.error("Facebook Page token write failed:", error);
  }
}

function loadFacebookPageConnection() {
  try {
    if (process.env.FB_PAGE_ACCESS_TOKEN) {
      return {
        access_token: process.env.FB_PAGE_ACCESS_TOKEN,
        page_id: process.env.FB_PAGE_ID || process.env.META_PAGE_ID || ""
      };
    }
    const path = "data/facebook-page-token.json";
    if (fs.existsSync(path)) {
      const saved = JSON.parse(fs.readFileSync(path, "utf8"));
      return {
        access_token: saved?.access_token || "",
        page_id: saved?.page_id || ""
      };
    }
  } catch (error) {
    console.error("Facebook Page connection load failed:", error);
  }
  return { access_token: "", page_id: "" };
}

function loadFacebookPageToken() {
  return loadFacebookPageConnection().access_token;
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
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InstaPost Simple Version 04</title>
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
  font-weight:bold;

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

<h1>InstaPost Simple Version 04</h1>
<p>영상 선택 → 게시글 입력 → Instagram + Facebook 동시 게시</p>

<div class="card">
<button id="fbConnect" type="button" onclick="window.location.href='/facebook/login'">Facebook 연결</button>
<div id="fbStatus">Facebook 연결 상태 확인 중...</div>
</div>

<div class="card">

<input
  id="video"
  type="file"
  accept="video/mp4,video/quicktime,video/*"
>

<video id="preview" controls hidden></video>
<div id="fileInfo" style="margin-top:12px;color:#bbb"></div>

</div>

<div class="card">

<textarea
  id="caption"
  placeholder="게시글 내용을 입력하세요."
></textarea>

<button id="post" type="button" onclick="(async()=>{const b=this,f=document.getElementById('video').files[0],r=document.getElementById('result'),i=document.getElementById('fileInfo');if(!f){r.textContent='❌ 영상을 먼저 선택하세요.';return;}b.textContent='⏳ 서버 전송 중...';i.textContent='📤 '+f.name+' — 서버로 전송 중...';r.textContent='① 게시 버튼 작동 — 영상 업로드 중...';const fd=new FormData();fd.append('video',f);fd.append('caption',document.getElementById('caption').value||'');try{const x=await fetch('/publish',{method:'POST',body:fd});const d=await x.json();if(!x.ok)throw new Error(d.error||'게시 실패');b.textContent='✅ 게시 완료';i.textContent=d.facebook&&d.facebook.ok?'✅ Instagram + Facebook 게시 완료':'✅ Instagram 게시 완료';r.textContent=d.facebook&&d.facebook.ok?'③ Instagram + Facebook 동시 게시 완료':'③ Instagram 게시 완료';}catch(e){b.textContent='❌ 게시 실패';i.textContent='❌ 게시 실패';r.textContent='❌ '+e.message;}})()">
Instagram + Facebook에 게시
</button>

<button id="personalShare" type="button">Facebook 개인 피드 공유</button>
<div id="shareInfo" style="margin-top:10px;color:#bbb"></div>

<div id="result"></div>

</div>

</main>

<script>
const video = document.getElementById("video");
const preview = document.getElementById("preview");
const result = document.getElementById("result");
const fbStatus = document.getElementById("fbStatus");
const fileInfo = document.getElementById("fileInfo");
const postButton = document.getElementById("post");
let facebookShareUrl = "";

document.getElementById("personalShare").onclick = function () {
  if (!facebookShareUrl) {
    document.getElementById("shareInfo").textContent = "먼저 Instagram + Facebook에 게시하세요. 게시 완료 후 개인 피드 공유가 가능합니다.";
    return;
  }
  window.open("https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(facebookShareUrl), "_blank");
};

async function checkFacebookStatus() {
  try {
    const response = await fetch("/facebook-status");
    const data = await response.json();
    if (data.connected) {
      fbStatus.textContent = "✅ Facebook 연결 완료";
      document.getElementById("fbConnect").textContent = "Facebook 다시 연결";
    } else {
      fbStatus.textContent = "⚠️ Facebook이 아직 연결되지 않았습니다.";
    }
  } catch (error) {
    fbStatus.textContent = "Facebook 연결 상태 확인 실패";
  }
}

document.getElementById("fbConnect").onclick = () => {
  window.location.href = "/facebook/login";
};

checkFacebookStatus();

video.onchange = () => {

  const file = video.files[0];

  if (!file) {
    preview.hidden = true;
    fileInfo.textContent = "";
    return;
  }

  preview.src = URL.createObjectURL(file);
  preview.hidden = false;

  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
  fileInfo.textContent =
    "✅ 영상 선택 완료 — " + file.name + " (" + sizeMB + " MB)";

};

async function publishVideo() {

  const file = video.files[0];

  if (!file) {
    result.textContent = "❌ 영상을 먼저 선택하세요.";
    return;
  }

  // Immediate visual confirmation that the button action fired.
  result.textContent = "① 게시 버튼 작동 — 영상 업로드 준비 중...";
  fileInfo.textContent = "📤 " + file.name + " — 서버로 전송 중...";

  const form = new FormData();
  form.append("video", file);
  form.append("caption", document.getElementById("caption").value || "");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    const response = await fetch("/publish", {
      method: "POST",
      body: form,
      signal: controller.signal
    });

    clearTimeout(timer);

    result.textContent = "② 서버 업로드 완료 — Instagram 처리 중...";

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "게시 실패");
    }

    const fb = data.facebook;

    if (fb && fb.ok) {
      facebookShareUrl = fb.shareUrl || "";
      document.getElementById("shareInfo").textContent = "Facebook 게시 완료 — 아래 개인 피드 공유 버튼을 눌러주세요.";
      fileInfo.textContent = "✅ Instagram + Facebook 게시 완료";
      result.textContent = "③ Instagram + Facebook 동시 게시 완료";
    } else if (fb && fb.skipped) {
      fileInfo.textContent = "⚠️ Instagram 게시 완료";
      result.textContent =
        "③ Instagram 게시 완료\n⚠️ Facebook: " +
        (fb.reason || "연결되지 않음");
    } else {
      fileInfo.textContent = "✅ Instagram 게시 완료";
      result.textContent = "③ Instagram 게시 완료";
    }

  } catch (error) {
    if (error.name === "AbortError") {
      fileInfo.textContent = "❌ 게시 시간 초과";
      result.textContent =
        "❌ 2분 동안 게시 응답이 없습니다. 서버 처리 상태를 확인해야 합니다.";
    } else {
      fileInfo.textContent = "❌ 게시 실패";
      result.textContent = "❌ " + error.message;
    }
  }
}

</script>

</body>
</html>
`);
});

app.get("/facebook/login", (req, res) => {
  const config = getFacebookConfig();

  if (!config.appId || !config.configId) {
    return res.status(500).send(
      "Facebook Login for Business 설정이 필요합니다. Railway Variables에 FB_APP_ID와 FB_CONFIG_ID를 설정하세요."
    );
  }

  const state = Buffer.from(
    JSON.stringify({ t: Date.now() }),
    "utf8"
  ).toString("base64url");

  // This app uses Meta's Facebook Login for Business configuration.
  // The configuration ID controls the assets/permissions selected in Meta.
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    config_id: config.configId,
    response_type: "code",
    override_default_response_type: "true"
  });

  const loginUrl =
    "https://www.facebook.com/dialog/oauth?" +
    params.toString();

  res.redirect(loginUrl);
});

app.get("/facebook-config", (req, res) => {
  const config = getFacebookConfig();
  if (!config.appId || !config.configId) {
    return res.status(500).json({
      ok: false,
      error: "FB_APP_ID 또는 FB_CONFIG_ID가 없습니다."
    });
  }

  const state = Buffer.from(
    JSON.stringify({ t: Date.now() }),
    "utf8"
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    config_id: config.configId,
    response_type: "code",
    override_default_response_type: "true"
  });

  res.json({
    ok: true,
    app_id: config.appId,
    config_id: config.configId,
    redirect_uri: config.redirectUri,
    login_url:
      "https://www.facebook.com/dialog/oauth?" +
      params.toString()
  });
});

app.use(express.json());

app.get("/facebook-env-debug", (req, res) => {
  const config = getFacebookConfig();
  res.json({
    ok: true,
    app_id_present: !!config.appId,
    app_secret_present: !!config.appSecret,
    config_id: config.configId,
    redirect_uri: config.redirectUri,
    page_id_present: !!config.pageId
  });
});

app.get("/facebook/callback", async (req, res) => {
  try {
    const config = getFacebookConfig();

    if (!config.appId || !config.appSecret) {
      return res.status(500).send(
        "Facebook 콜백에 FB_APP_ID와 FB_APP_SECRET이 필요합니다. Railway Variables를 확인하세요."
      );
    }

    if (req.query.error) {
      return res.status(400).send(
        "Facebook 연결이 취소되었습니다: " +
        String(req.query.error_description || req.query.error)
      );
    }

    const code = String(req.query.code || "");
    if (!code) {
      return res.status(400).send("Facebook authorization code가 없습니다.");
    }

    const tokenUrl =
      "https://graph.facebook.com/" +
      (process.env.META_API_VERSION || "v26.0") +
      "/oauth/access_token?" +
      new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        redirect_uri: config.redirectUri,
        code
      }).toString();

    console.log("Facebook OAuth callback: exchanging authorization code...");
    const tokenResponse = await fetchWithTimeout(tokenUrl);
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData?.access_token) {
      return res.status(502).json({
        ok: false,
        error: tokenData?.error?.message || "Facebook 사용자 토큰 발급 실패"
      });
    }

    const userToken = tokenData.access_token;
    const accountsUrl =
      "https://graph.facebook.com/" +
      (process.env.META_API_VERSION || "v26.0") +
      "/me/accounts?fields=id,name,access_token,tasks&access_token=" +
      encodeURIComponent(userToken);

    console.log("Facebook OAuth callback: loading managed Pages...");
    const accountsResponse = await fetchWithTimeout(accountsUrl);
    const accountsData = await accountsResponse.json();

    if (!accountsResponse.ok || !Array.isArray(accountsData?.data)) {
      console.error("Facebook Page lookup failed:", accountsData);
      return res.status(502).send(
        "<h2>❌ Facebook Page 연결 실패</h2>" +
        "<p>" +
        String(
          accountsData?.error?.message ||
          "관리 중인 Facebook Page를 찾지 못했습니다."
        ) +
        "</p><p>Facebook 권한 승인 후 Page 접근 권한이 있는지 확인하세요.</p>"
      );
    }

    // Some Facebook Login for Business responses list the Page but do not
    // include access_token in /me/accounts. In that case, request the token
    // directly from the selected Page using the freshly issued user token.
    let selected =
      accountsData.data.find(p => config.pageId && p.id === config.pageId) ||
      accountsData.data.find(p => p.access_token) ||
      accountsData.data[0];

    if (selected?.id && !selected?.access_token) {
      const pageUrl =
        "https://graph.facebook.com/" +
        (process.env.META_API_VERSION || "v26.0") +
        "/" +
        encodeURIComponent(selected.id) +
        "?fields=id,name,access_token,tasks&access_token=" +
        encodeURIComponent(userToken);

      console.log("Facebook OAuth callback: requesting Page access token directly...");
      const pageResponse = await fetchWithTimeout(pageUrl);
      const pageData = await pageResponse.json();

      if (pageResponse.ok && pageData?.access_token) {
        selected = pageData;
      } else {
        console.error("Facebook direct Page token lookup failed:", pageData);
      }
    }

    if (!selected?.access_token || !selected?.id) {
      // Diagnostic only: never expose the actual user/Page access token.
      // Show the permission state and Page count so the exact missing
      // Facebook Login for Business permission can be identified.
      let permissionData = null;
      let userData = null;

      try {
        const permissionUrl =
          "https://graph.facebook.com/" +
          (process.env.META_API_VERSION || "v26.0") +
          "/me/permissions?access_token=" +
          encodeURIComponent(userToken);
        const permissionResponse = await fetchWithTimeout(permissionUrl);
        permissionData = await permissionResponse.json();
      } catch (diagnosticError) {
        console.error("Facebook permission diagnostic failed:", diagnosticError);
      }

      try {
        const userUrl =
          "https://graph.facebook.com/" +
          (process.env.META_API_VERSION || "v26.0") +
          "/me?fields=id,name&access_token=" +
          encodeURIComponent(userToken);
        const userResponse = await fetchWithTimeout(userUrl);
        userData = await userResponse.json();
      } catch (diagnosticError) {
        console.error("Facebook user diagnostic failed:", diagnosticError);
      }

      const pageNames = accountsData.data
        .map(p => p?.name || p?.id)
        .filter(Boolean)
        .join(", ");

      const permissionSummary = Array.isArray(permissionData?.data)
        ? permissionData.data
            .map(p => String(p.status || "") + ":" + String(p.permission || ""))
            .join("<br>")
        : "권한 정보를 가져오지 못했습니다.";

      return res.status(400).send(
        "<h2>❌ Facebook Page Access Token을 찾지 못했습니다.</h2>" +
        "<p><b>로그인 사용자:</b> " +
        String(userData?.name || userData?.id || "확인 안 됨") +
        "</p>" +
        "<p><b>확인된 Page 수:</b> " +
        String(accountsData.data.length) +
        "</p>" +
        "<p><b>확인된 Page:</b> " +
        String(pageNames || "없음") +
        "</p>" +
        "<p><b>현재 승인된 권한:</b><br>" +
        permissionSummary +
        "</p>" +
        "<p>이 화면을 캡처해서 보내주세요. 토큰은 표시하지 않습니다.</p>"
      );
    }

    saveFacebookPageToken(selected.access_token, selected.id);

    res.send(
      "<h2>✅ Facebook 연결 완료</h2>" +
      "<p>Page: " +
      String(selected.name || selected.id) +
      "</p>" +
      "<p>이제 InstaPost Simple Version 03에서 Instagram + Facebook 동시 게시가 가능합니다.</p>"
    );
  } catch (error) {
    console.error("Facebook OAuth callback failed:", error);
    const message =
      error?.name === "AbortError"
        ? "Facebook 서버 응답이 너무 오래 걸렸습니다. 다시 연결해 주세요."
        : (error?.message || "알 수 없는 오류");
    res.status(500).send(
      "<h2>❌ Facebook 연결 오류</h2>" +
      "<p>" + String(message) + "</p>" +
      "<p><a href='/'>InstaPost Simple로 돌아가기</a></p>"
    );
  }
});

app.get("/facebook-status", (req, res) => {
  const connection = loadFacebookPageConnection();
  const config = getFacebookConfig();

  res.json({
    connected: !!connection.access_token,
    page_id: config.pageId || connection.page_id || null,
    note: "토큰 값은 표시하지 않습니다."
  });
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

async function publishFacebookPageReel(videoPath, description) {
  const config = getFacebookConfig();
  const connection = loadFacebookPageConnection();
  const pageId = config.pageId || connection.page_id;
  const pageToken = connection.access_token;

  if (!pageId || !pageToken) {
    return {
      skipped: true,
      reason: "FB_PAGE_ID 또는 FB_PAGE_ACCESS_TOKEN이 설정되지 않았습니다."
    };
  }

  const version = process.env.META_API_VERSION || "v26.0";
  const stat = fs.statSync(videoPath);

  // 1) Start resumable Facebook Page Reel upload.
  const startBody = new URLSearchParams();
  startBody.append("upload_phase", "start");
  startBody.append("access_token", pageToken);

  const startResponse = await fetch(
    "https://graph.facebook.com/" + version + "/" + pageId + "/video_reels",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: startBody
    }
  );
  const started = await startResponse.json();

  if (!startResponse.ok || !started.video_id || !started.upload_url) {
    throw new Error(
      started?.error?.message || "Facebook Reel 업로드 시작에 실패했습니다."
    );
  }

  // 2) Upload the video bytes to Facebook's resumable upload URL.
  const fileBuffer = fs.readFileSync(videoPath);
  const uploadResponse = await fetch(started.upload_url, {
    method: "POST",
    headers: {
      Authorization: "OAuth " + pageToken,
      offset: "0",
      file_size: String(stat.size),
      "Content-Type": "application/octet-stream"
    },
    body: fileBuffer
  });
  const uploadedText = await uploadResponse.text();
  let uploaded = {};
  try { uploaded = JSON.parse(uploadedText); } catch {}

  if (!uploadResponse.ok || uploaded.success === false) {
    throw new Error(
      uploaded?.error?.message || uploadedText || "Facebook Reel 영상 업로드에 실패했습니다."
    );
  }

  // 3) Finish and publish the Reel to the Facebook Page.
  const finishBody = new URLSearchParams();
  finishBody.append("upload_phase", "finish");
  finishBody.append("video_id", started.video_id);
  finishBody.append("video_state", "PUBLISHED");
  finishBody.append("description", description || "");
  finishBody.append("access_token", pageToken);

  const finishResponse = await fetch(
    "https://graph.facebook.com/" + version + "/" + pageId + "/video_reels",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: finishBody
    }
  );
  const finished = await finishResponse.json();

  if (!finishResponse.ok || finished.success === false) {
    throw new Error(
      finished?.error?.message || "Facebook Reel 게시에 실패했습니다."
    );
  }

  return {
    skipped: false,
    ok: true,
    videoId: started.video_id,
    shareUrl: "https://www.facebook.com/" + pageId + "/videos/" + started.video_id
  };
}

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

      // Poll Instagram processing status more frequently so publishing
      // does not appear unnecessarily stalled.
      for (let i=0;i<30;i++) {

        await new Promise(
          resolve =>
          setTimeout(resolve,2000)
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

      console.log("Instagram publish completed. Starting Facebook Reel publish...");
      const facebookResult = await Promise.race([
        publishFacebookPageReel(
          req.file.path,
          req.body.caption || ""
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Facebook Reel 게시가 45초 이상 걸려 중단되었습니다.")),
            45000
          )
        )
      ]);

      fs.rmSync(req.file.path, { force: true });

      res.json({
        ok: true,
        instagram: {
          ok: true,
          mediaId: published.id
        },
        facebook: facebookResult
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

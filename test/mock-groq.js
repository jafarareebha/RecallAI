/* Local stand-in for Groq's OpenAI-compatible API, used by the tests only.
   It records every request so tests can inspect exactly what the backend sent. */
const http = require("http");

const ANSWERS = [
  [/address already in use/i, "Port 8000 is already being used by another process. You can find and stop that process, or run your server on another port, for example `uvicorn main:app --port 8001`."],
  [/modulenotfounderror|django module|no module named/i, "This happens because the virtual environment was not activated, so Python cannot see Django. Activate your virtual environment and install your dependencies with `pip install -r requirements.txt`."],
  [/database_url/i, "The deployment is failing because the production environment is missing DATABASE_URL. Add DATABASE_URL to your production environment variables and redeploy."],
  [/connection (?:is )?(?:being )?refused/i, "A refused connection means the app reached a database endpoint but nothing accepted it. Check the database host and port, and whether the database is actually running."],
  [/nullpointer/i, "A NullPointerException means something in your billing code is null when it is dereferenced. Check the stack trace for the exact line and add a null check or fix the initialization."],
  [/binary search/i, "Binary search finds a target in a sorted array by repeatedly halving the search range. It runs in O(log n) time."],
  [/docker/i, "Docker is a platform that packages an application and its dependencies into a container so it runs the same way everywhere."],
  [/render/i, "To deploy Django on Render, create a Web Service, set the build command to install requirements, and start the app with gunicorn."]
];

function start() {
  const state = { requests: [], mode: "ok", extractMode: "json", failCount: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404).end("{}"); return; }
      const body = JSON.parse(raw || "{}");
      const auth = req.headers.authorization || "";
      const sys = (body.messages || []).find(m => m.role === "system")?.content || "";
      const isExtract = sys.startsWith("You extract a structured debugging memory");
      state.requests.push({ body, auth, isExtract, sys });

      if (state.mode === "fail500") { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "upstream exploded at /secret/path stack:...", type: "server_error" } })); return; }
      if (state.mode === "model404" && body.model === state.deadModel) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The model `" + body.model + "` does not exist", code: "model_not_found" } })); return; }
      if (!/^Bearer gsk_/.test(auth)) { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API Key" } })); return; }

      const last = [...body.messages].reverse().find(m => m.role === "user")?.content || "";

      if (isExtract) {
        if (state.extractMode === "fail") { res.writeHead(500).end("{}"); return; }
        const u = JSON.parse(last);
        const j = /modulenotfounderror/i.test(u.user_message)
          ? { error: "ModuleNotFoundError: No module named 'django'", exception_type: "ModuleNotFoundError", context: "Django project running locally", cause: "Virtual environment was not activated", solution: "Activate the virtual environment and install dependencies", technologies: ["django", "python"] }
          : { error: u.user_message.slice(0, 80), exception_type: "", context: "LLM-extracted context", cause: "LLM-extracted cause", solution: "LLM-extracted solution", technologies: [] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(j) } }] }));
        return;
      }

      let answer = (ANSWERS.find(([re]) => re.test(last)) || [null, "Sure. Here is a helpful answer about: " + last.slice(0, 60)])[1];
      if (/^(hi|hello|hey)\b/i.test(last)) answer = "Hey! How can I help you?";
      // memory prompt: the real model is told to write "Previous solution:" then "Current solution:"
      const memCount = (sys.match(/\[Memory\]/g) || []).length;
      if (memCount) {
        const prev = (sys.match(/^ {2}Cause: (.+)$/m) || sys.match(/^ {2}Fix \/ solution: (.+)$/m) || [])[1] || "An earlier issue was recorded.";
        answer = "Previous solution: " + prev + "\n\nCurrent solution: (context: " + memCount + " memories) " + answer;
      }

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ delta: { reasoning: "SECRET-REASONING-TOKENS " } }] }) + "\n\n");
        for (const w of answer.split(/(?<= )/)) res.write("data: " + JSON.stringify({ choices: [{ delta: { content: w } }] }) + "\n\n");
        res.write("data: [DONE]\n\n"); res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      }
    });
  });
  return new Promise(r => server.listen(0, () => r({ server, state, url: "http://127.0.0.1:" + server.address().port + "/openai/v1" })));
}
module.exports = { start };

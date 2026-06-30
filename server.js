const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { scrapeCourse } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();

function sse(evt) {
  return `data: ${JSON.stringify(evt)}\n\n`;
}

function pushEvent(job, evt) {
  job.events.push(evt);
  for (const res of job.subscribers) res.write(sse(evt));
}

app.post("/scrape", (req, res) => {
  const { courseUrl, username, password } = req.body || {};

  if (!courseUrl || !username || !password) {
    return res.status(400).json({ error: "courseUrl, username and password are required." });
  }
  try {
    new URL(courseUrl);
  } catch {
    return res.status(400).json({ error: "courseUrl is not a valid URL." });
  }

  const jobId = crypto.randomUUID();
  const job = { events: [], subscribers: new Set(), zip: null, name: null, finished: false };
  jobs.set(jobId, job);

  console.log(`Scrape request ${jobId}: ${courseUrl} (user ${username})`);

  scrapeCourse({
    courseUrl,
    username,
    password,
    onLog: line => console.log(line),
    onEvent: evt => pushEvent(job, evt),
  })
    .then(({ zip, name }) => {
      job.zip = zip;
      job.name = name;
      pushEvent(job, { type: "ready", name });
    })
    .catch(e => {
      console.error(`Scrape ${jobId} failed:`, e.message);
      pushEvent(job, { type: "error", message: e.message });
    })
    .finally(() => {
      job.finished = true;
      for (const res of job.subscribers) res.end();
      job.subscribers.clear();
    });

  res.json({ jobId });
});

app.get("/events/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  for (const evt of job.events) res.write(sse(evt));

  if (job.finished) return res.end();
  job.subscribers.add(res);
  req.on("close", () => job.subscribers.delete(res));
});

app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.zip) return res.status(404).end();

  const filename = `${job.name || "moodle-course"}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", job.zip.length);
  res.end(job.zip);

  jobs.delete(req.params.jobId);
});

app.listen(PORT, () => {
  console.log(`Moodle scraper running at http://localhost:${PORT}`);
});

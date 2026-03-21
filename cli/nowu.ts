#!/usr/bin/env -S node --experimental-strip-types --no-warnings

const BASE_URL = process.env.NOWU_API_URL ?? "https://api.pranitmane.com";
const TOKEN = process.env.NOWU_API_TOKEN;

if (!TOKEN) {
  console.error("Error: NOWU_API_TOKEN is not set. Export it in your shell:");
  console.error('  export NOWU_API_TOKEN="your-token-here"');
  process.exit(1);
}

async function api(method: string, path: string, body?: object) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      console.error(`Error ${res.status}:`, JSON.stringify(json, null, 2));
    } catch {
      console.error(`Error ${res.status}:`, text);
    }
    process.exit(1);
  }
  return res.json();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${HH}:${MM}`;
}

function displayPost(post: { content: string; uid: string; createdAt: string }) {
  console.log(post.content);
  console.log(`-- ${formatDate(post.createdAt)} | ${post.uid}`);
}

async function cmdPost(args: string[]) {
  const content = args.join(" ").trim();
  if (!content) {
    console.error("Error: post content cannot be empty.");
    process.exit(1);
  }
  const data = await api("POST", "/posts", { content });
  console.log(`${data.uid} | inserted successfully`);
}

async function cmdLast(args: string[]) {
  const n = args[0] ? parseInt(args[0], 10) : 1;
  if (isNaN(n) || n < 1) {
    console.error("Error: argument must be a positive number.");
    process.exit(1);
  }
  const data = await api("GET", `/posts/last?n=${n}`);
  const posts: any[] = data.posts ?? [];
  posts.forEach((post, i) => {
    if (i > 0) console.log();
    displayPost(post);
  });
}

async function cmdTrash(args: string[]) {
  const n = args[0] ? parseInt(args[0], 10) : 1;
  if (isNaN(n) || n < 1) {
    console.error("Error: argument must be a positive number.");
    process.exit(1);
  }
  const data = await api("GET", `/posts/trash?limit=${n}`);
  const posts: any[] = data.posts ?? [];
  if (posts.length === 0) {
    console.log("No deleted posts.");
    return;
  }
  posts.forEach((post, i) => {
    if (i > 0) console.log();
    displayPost(post);
  });
}

async function cmdStats() {
  const data = await api("GET", "/posts/stats");
  console.log(`total   : ${data.total}`);
  console.log(`visible : ${data.visible}`);
  console.log(`deleted : ${data.deleted}`);
}

async function cmdGet(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowu get <uid>");
    process.exit(1);
  }
  const data = await api("GET", `/posts/${uid}`);
  displayPost(data);
}

async function cmdEdits(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowu edits <uid>");
    process.exit(1);
  }
  const data = await api("GET", `/posts/${uid}/edits`);
  const edits: any[] = data.edits ?? [];
  edits.forEach((edit, i) => {
    const label = i === 0 ? "[current]" : `[${edits.length - i}]`;
    console.log(`${label} edit #${edit.editNumber} | ${formatDate(edit.createdAt)}`);
    console.log(edit.content);
    if (i < edits.length - 1) console.log("---");
  });
}

async function cmdEdit(args: string[]) {
  const uid = args[0];
  const content = args.slice(1).join(" ").trim();
  if (!uid || !content) {
    console.error("Error: uid and new content required. Usage: nowu edit <uid> <new content>");
    process.exit(1);
  }
  await api("PATCH", `/posts/${uid}`, { content });
  console.log(`${uid} | updated`);
}

async function cmdDelete(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowu delete <uid>");
    process.exit(1);
  }
  await api("DELETE", `/posts/${uid}`);
  console.log(`${uid} | deleted`);
}

async function cmdRestore(args: string[]) {
  const uid = args[0];
  if (!uid) {
    console.error("Error: uid required. Usage: nowu restore <uid>");
    process.exit(1);
  }
  await api("POST", `/posts/${uid}/restore`);
  console.log(`${uid} | restored`);
}

function showHelp() {
  console.log(`nowu — post and manage thoughts from the terminal

Usage:
  nowu <text...>             create a new post
  nowu last [n]              show last N posts (default 1, max 10)
  nowu trash [n]             show last N deleted posts (default 1)
  nowu stats                 show total / visible / deleted counts
  nowu get <uid>             get a post by uid
  nowu edits <uid>           show full edit history for a post
  nowu edit <uid> <text...>  update a post's content
  nowu delete <uid>          soft-delete a post
  nowu restore <uid>         restore a deleted post
  nowu -h, --help            show this help

Environment variables:
  NOWU_API_TOKEN   Bearer token (required)
  NOWU_API_URL     API base URL (default: https://api.pranitmane.com)

Examples:
  nowu hello, back at chaayos again
  nowu last 3
  nowu edit abc123 updated content here
  nowu delete abc123`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "-h" || cmd === "--help") {
  showHelp();
} else if (cmd === "last") {
  cmdLast(rest);
} else if (cmd === "trash") {
  cmdTrash(rest);
} else if (cmd === "stats") {
  cmdStats();
} else if (cmd === "get") {
  cmdGet(rest);
} else if (cmd === "edits") {
  cmdEdits(rest);
} else if (cmd === "edit") {
  cmdEdit(rest);
} else if (cmd === "delete") {
  cmdDelete(rest);
} else if (cmd === "restore") {
  cmdRestore(rest);
} else {
  cmdPost([cmd, ...rest]);
}

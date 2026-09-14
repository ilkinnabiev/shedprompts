const token = location.hash.slice(1);

const form = document.querySelector("#task-form");
const submit = form.querySelector('button[type="submit"]');
const formStatus = document.querySelector("#form-status");
const connection = document.querySelector("#connection");
const configPath = document.querySelector("#config-path");
const taskList = document.querySelector("#task-list");
const emptyState = document.querySelector("#empty-state");
const refreshButton = document.querySelector("#refresh");
const timezone = document.querySelector("#timezone");
const atInput = document.querySelector("#task-at");
const cwdInput = document.querySelector("#task-cwd");
const agentInput = document.querySelector("#task-agent");

let revision = "";
let refreshing = false;
let hasAvailableAgent = false;

timezone.textContent = `/ ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
atInput.value = localDateTime(new Date(Date.now() + 60 * 60 * 1000));
atInput.min = localDateTime(new Date(Date.now() + 60 * 1000));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity() || !revision) {
    return;
  }

  const values = new FormData(form);
  const localAt = new Date(String(values.get("at")));
  if (Number.isNaN(localAt.valueOf())) {
    showFormStatus("Choose a valid local date and time.", "error");
    return;
  }

  const cwd = String(values.get("cwd") ?? "").trim();
  const args = String(values.get("args") ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const payload = {
    revision,
    id: String(values.get("id") ?? "").trim(),
    at: localAt.toISOString(),
    agent: String(values.get("agent") ?? ""),
    prompt: String(values.get("prompt") ?? ""),
    ...(cwd ? { cwd } : {}),
    ...(args.length ? { args } : {}),
  };

  submit.disabled = true;
  showFormStatus("Writing task to YAML…");
  try {
    await request("/api/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shed-Token": token,
      },
      body: JSON.stringify(payload),
    });
    form.reset();
    atInput.value = localDateTime(new Date(Date.now() + 60 * 60 * 1000));
    atInput.min = localDateTime(new Date(Date.now() + 60 * 1000));
    showFormStatus(`Scheduled ${payload.id}.`, "success");
    await refresh();
    document.querySelector("#task-id").focus();
  } catch (error) {
    showFormStatus(error.message, "error");
    await refresh();
  } finally {
    submit.disabled = !hasAvailableAgent;
  }
});

refreshButton.addEventListener("click", () => {
  void refresh(true);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refresh();
  }
});

async function refresh(announce = false) {
  if (refreshing) {
    return;
  }
  refreshing = true;
  try {
    const data = await request("/api/tasks");
    revision = data.config.revision;
    configPath.textContent = data.config.path;
    configPath.title = data.config.path;
    cwdInput.placeholder = data.config.directory;
    updateAgents(data.agents);
    renderTasks(data.tasks, data.now);
    setConnection("synced", "online");
    if (announce) {
      showFormStatus("Queue refreshed.");
    }
  } catch (error) {
    setConnection("offline", "offline");
    if (announce) {
      showFormStatus(error.message, "error");
    }
  } finally {
    refreshing = false;
  }
}

function renderTasks(tasks, now) {
  taskList.replaceChildren();
  emptyState.hidden = tasks.length !== 0;

  let pending = 0;
  let running = 0;
  let finished = 0;
  const nowTime = new Date(now).getTime();

  for (const task of tasks) {
    if (task.status === "pending") {
      pending += 1;
    } else if (task.status === "running") {
      running += 1;
    } else {
      finished += 1;
    }

    const article = document.createElement("article");
    article.className = "task";
    article.dataset.status = task.status;

    const topline = document.createElement("div");
    topline.className = "task-topline";

    const id = document.createElement("span");
    id.className = "task-id";
    id.textContent = task.id;
    id.title = task.id;

    const agent = document.createElement("span");
    agent.className = "agent-label";
    agent.textContent = task.agent;

    const overdue =
      task.status === "pending" && new Date(task.at).getTime() <= nowTime;
    const status = document.createElement("span");
    status.className = `task-status status-${task.status}`;
    status.textContent = overdue ? "pending / overdue" : task.status;

    topline.append(id, agent, status);

    const prompt = document.createElement("p");
    prompt.className = "task-prompt";
    prompt.textContent = task.prompt.trim();

    const meta = document.createElement("div");
    meta.className = "task-meta";

    const time = document.createElement("time");
    time.dateTime = task.at;
    time.title = task.at;
    time.textContent = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(task.at));

    const cwd = document.createElement("span");
    cwd.textContent = task.cwd;
    cwd.title = task.cwd;
    meta.append(time, cwd);

    article.append(topline, prompt, meta);
    if (task.error) {
      const error = document.createElement("p");
      error.className = "task-error";
      error.textContent = task.error;
      article.append(error);
    }
    taskList.append(article);
  }

  document.querySelector("#pending-count").textContent = String(pending);
  document.querySelector("#running-count").textContent = String(running);
  document.querySelector("#finished-count").textContent = String(finished);
}

function updateAgents(agents) {
  const options = [...agentInput.options];
  for (const option of options) {
    const available = agents[option.value] === true;
    const label = option.value === "claude" ? "Claude Code" : option.value;
    option.disabled = !available;
    option.textContent = available
      ? label
      : `${label} / unavailable`;
  }

  if (agentInput.selectedOptions[0]?.disabled) {
    const available = options.find((option) => !option.disabled);
    if (available) {
      agentInput.value = available.value;
    }
  }
  hasAvailableAgent = options.some((option) => !option.disabled);
  submit.disabled = !hasAvailableAgent;
}

async function request(path, options) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      "X-Shed-Token": token,
      ...options?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function localDateTime(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function showFormStatus(message, tone = "") {
  formStatus.textContent = message;
  formStatus.className = tone;
}

function setConnection(label, state) {
  connection.lastChild.textContent = label;
  connection.className = `connection ${state}`;
}

void refresh();
setInterval(() => void refresh(), 3_000);

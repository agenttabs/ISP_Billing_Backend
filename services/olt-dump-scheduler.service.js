const { spawn } = require("child_process");
const path = require("path");
const mongoose = require("mongoose");
const collections = require("../config/collections");
const { writeAuditLog } = require("./audit-log.service");

const MANILA_TIMEZONE = "Asia/Manila";
const BACKEND_ROOT = path.resolve(__dirname, "..");

const defaultOltDumpSchedulerConfig = () => ({
  Name: "OLT Dump Scheduler",
  SendTime: "06:00",
  ScheduleTimes: ["06:00"],
  IsActive: false,
  RunGpon: true,
  RunEpon: true,
  LastRunKey: "",
  LastScheduledRunKey: "",
  LastScheduledRunKeys: {},
  LastRunAt: null,
  LastRunSummary: "",
  LastError: "",
  LastOutput: ""
});

const normalizeScheduleTimes = (config = {}, defaults = defaultOltDumpSchedulerConfig()) => {
  const source = Array.isArray(config?.ScheduleTimes) && config.ScheduleTimes.length
    ? config.ScheduleTimes
    : [config?.SendTime || defaults.SendTime];

  const times = source
    .map((value) => String(value || "").trim())
    .filter((value) => getMinutesFromTimeKey(value) !== null);

  return [...new Set(times)].sort(
    (a, b) => getMinutesFromTimeKey(a) - getMinutesFromTimeKey(b)
  );
};

const sanitizeConfig = (config = {}) => {
  const defaults = defaultOltDumpSchedulerConfig();
  const scheduleTimes = normalizeScheduleTimes(config, defaults);

  return {
    ...defaults,
    ...(config || {}),
    Name: String(config?.Name || defaults.Name).trim() || defaults.Name,
    SendTime: scheduleTimes[0] || defaults.SendTime,
    ScheduleTimes: scheduleTimes.length ? scheduleTimes : defaults.ScheduleTimes,
    IsActive: Boolean(config?.IsActive),
    RunGpon: config?.RunGpon === undefined ? defaults.RunGpon : Boolean(config?.RunGpon),
    RunEpon: config?.RunEpon === undefined ? defaults.RunEpon : Boolean(config?.RunEpon),
    LastRunKey: String(config?.LastRunKey || "").trim(),
    LastScheduledRunKey: String(config?.LastScheduledRunKey || "").trim(),
    LastScheduledRunKeys:
      config?.LastScheduledRunKeys &&
      typeof config.LastScheduledRunKeys === "object" &&
      !Array.isArray(config.LastScheduledRunKeys)
        ? config.LastScheduledRunKeys
        : {},
    LastRunAt: config?.LastRunAt || null,
    LastRunSummary: String(config?.LastRunSummary || "").trim(),
    LastError: String(config?.LastError || "").trim(),
    LastOutput: String(config?.LastOutput || "").trim()
  };
};

const getCollection = () => mongoose.connection.db.collection(collections.oltDumpScheduler);

const getConfigDocument = async () => {
  const current = await getCollection().findOne({});
  return sanitizeConfig(current || {});
};

const saveConfigDocument = async (values = {}) => {
  const collection = getCollection();
  const current = await collection.findOne({});
  const nextConfig = sanitizeConfig({
    ...(current || {}),
    ...(values || {}),
    updatedAt: new Date()
  });

  if (current?._id) {
    await collection.updateOne(
      { _id: current._id },
      {
        $set: {
          ...nextConfig,
          updatedAt: new Date()
        }
      }
    );
  } else {
    await collection.insertOne({
      ...nextConfig,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  return nextConfig;
};

const getManilaDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(values.year || 0),
    month: Number(values.month || 0),
    day: Number(values.day || 0),
    hour: Number(values.hour || 0),
    minute: Number(values.minute || 0),
    second: Number(values.second || 0)
  };
};

const getManilaDateKey = (date = new Date()) => {
  const parts = getManilaDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

const getMinutesFromTimeKey = (value) => {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);

  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = String(match[3] || "").trim().toLowerCase();

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
  }

  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return hours * 60 + minutes;
};

const runNodeScript = (scriptPath) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: BACKEND_ROOT,
      windowsHide: true,
      env: process.env
    });

    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        script: path.basename(scriptPath),
        success: false,
        code: null,
        output,
        error: error.message
      });
    });
    child.on("close", (code) => {
      resolve({
        script: path.basename(scriptPath),
        success: code === 0,
        code,
        output,
        error: code === 0 ? "" : `${path.basename(scriptPath)} exited with code ${code}`
      });
    });
  });

const runOltDumpNow = async ({
  triggeredBy = "",
  configOverrides = {},
  scheduledRunKey = ""
} = {}) => {
  const storedConfig = await getConfigDocument();
  const config = sanitizeConfig({
    ...storedConfig,
    ...(configOverrides || {})
  });

  const scripts = [];
  if (config.RunGpon) scripts.push(path.join(BACKEND_ROOT, "migration", "dump.gpon.telnet.js"));
  if (config.RunEpon) scripts.push(path.join(BACKEND_ROOT, "migration", "dump.epon-olt-telnet.js"));

  if (!scripts.length) {
    throw new Error("No OLT dump type selected. Enable GPON, EPON, or both.");
  }

  const results = [];
  for (const script of scripts) {
    const result = await runNodeScript(script);
    results.push(result);
    if (!result.success) {
      break;
    }
  }

  const failed = results.find((result) => !result.success);
  const generatedAt = new Date();
  const output = results
    .map((result) => `--- ${result.script} ---\n${String(result.output || "").trim()}`)
    .join("\n\n")
    .trim()
    .slice(-12000);
  const summary = failed
    ? `OLT dump failed at ${failed.script}.`
    : `OLT dump finished. Ran ${results.map((result) => result.script).join(", ")}.`;

  const nextConfig = await saveConfigDocument({
    ...config,
    LastRunKey: getManilaDateKey(generatedAt),
    ...(triggeredBy
      ? {}
      : {
          LastScheduledRunKey: scheduledRunKey || getManilaDateKey(generatedAt),
          LastScheduledRunKeys: {
            ...(config.LastScheduledRunKeys || {}),
            [scheduledRunKey || getManilaDateKey(generatedAt)]: generatedAt.toISOString()
          }
        }),
    LastRunAt: generatedAt,
    LastRunSummary: summary,
    LastError: failed ? failed.error : "",
    LastOutput: output
  });

  await writeAuditLog({
    actor: {
      name: triggeredBy || "Scheduler",
      username: triggeredBy || "scheduler",
      loginAccount: triggeredBy || "scheduler",
      type: triggeredBy ? "MANUAL" : "SCHEDULER"
    },
    module: "OLT_DUMP_SCHEDULER",
    action: triggeredBy ? "RUN_NOW" : "RUN_SCHEDULED",
    targetType: "OLT_DUMP_SCHEDULER",
    status: failed ? "FAILED" : "SUCCESS",
    summary,
    details: {
      scripts: results.map((result) => ({
        script: result.script,
        success: result.success,
        code: result.code,
        error: result.error
      }))
    }
  });

  if (failed) {
    const error = new Error(failed.error || summary);
    error.report = { config: nextConfig, results, summary, output };
    throw error;
  }

  return {
    config: nextConfig,
    results,
    summary,
    output
  };
};

let schedulerHandle = null;
let schedulerBusy = false;

const runScheduledOltDump = async () => {
  if (schedulerBusy) {
    return;
  }

  schedulerBusy = true;

  try {
    const config = await getConfigDocument();
    if (!config.IsActive) {
      return;
    }

    const scheduleTimes = normalizeScheduleTimes(config);
    if (!scheduleTimes.length) {
      return;
    }

    const now = new Date();
    const parts = getManilaDateParts(now);
    const currentMinutes = parts.hour * 60 + parts.minute;
    const todayKey = getManilaDateKey(now);
    const dueTime = scheduleTimes.find((timeKey) => {
      const targetMinutes = getMinutesFromTimeKey(timeKey);
      const scheduledRunKey = `${todayKey} ${timeKey}`;
      return (
        targetMinutes !== null &&
        currentMinutes >= targetMinutes &&
        config.LastScheduledRunKeys?.[scheduledRunKey] === undefined &&
        config.LastScheduledRunKey !== scheduledRunKey
      );
    });

    if (!dueTime) {
      return;
    }

    await runOltDumpNow({
      scheduledRunKey: `${todayKey} ${dueTime}`
    });
  } catch (err) {
    console.error("OLT DUMP SCHEDULER ERROR:", err.message);
    try {
      await saveConfigDocument({
        LastRunSummary: "Scheduled OLT dump failed.",
        LastError: err.message
      });
    } catch (innerErr) {
      console.error("OLT DUMP SCHEDULER SUMMARY ERROR:", innerErr.message);
    }
  } finally {
    schedulerBusy = false;
  }
};

const startOltDumpScheduler = () => {
  if (schedulerHandle) {
    return;
  }

  schedulerHandle = setInterval(runScheduledOltDump, 60 * 1000);
  setTimeout(runScheduledOltDump, 9000);
  console.log("OLT DUMP SCHEDULER STARTED");
};

module.exports = {
  defaultOltDumpSchedulerConfig,
  sanitizeConfig,
  getConfigDocument,
  saveConfigDocument,
  runOltDumpNow,
  startOltDumpScheduler
};

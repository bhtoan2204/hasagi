import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const LOCATION_ID = process.env.LOCATION_ID || "568";
const DEPARTMENT_ID = process.env.DEPARTMENT_ID || "110";
const TARGET_HOURS_PER_DAY = 9;
const TARGET_SECONDS_PER_DAY = TARGET_HOURS_PER_DAY * 3600;

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

const formatTime = (seconds) => {
  const absSeconds = Math.abs(Math.trunc(seconds));
  const hours = Math.floor(absSeconds / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const secs = absSeconds % 60;

  return `${hours}h ${minutes}m ${secs}s`;
};

const formatDuration = (seconds) => {
  const value = Math.trunc(seconds);
  const prefix = value < 0 ? "-" : "";
  const absSeconds = Math.abs(value);
  const hours = Math.floor(absSeconds / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const secs = absSeconds % 60;

  return `${prefix}${hours} giờ ${minutes} phút ${secs} giây`;
};

const getMonthRange = (year, month) => {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    fromDate: `${year}-${String(month).padStart(2, "0")}-01`,
    toDate: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    lastDay,
  };
};

const normalizeToken = (token) =>
  String(token || "").replace(/^Bearer\s+/i, "").trim();

const decodeJwtPayload = (jwt) => {
  try {
    const parts = String(jwt || "").split(".");

    if (parts.length !== 3) {
      return null;
    }

    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

const findValueByKeys = (value, keys) => {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    const jwtPayload = decodeJwtPayload(value);

    if (jwtPayload) {
      return findValueByKeys(jwtPayload, keys);
    }

    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueByKeys(item, keys);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  for (const key of keys) {
    const candidate = value[key];

    if (typeof candidate === "string" || typeof candidate === "number") {
      const normalized = String(candidate).trim();

      if (normalized) {
        return normalized;
      }
    }
  }

  for (const nestedValue of Object.values(value)) {
    const found = findValueByKeys(nestedValue, keys);

    if (found) {
      return found;
    }
  }

  return null;
};

const findStaffCode = (value) => {
  const explicit = findValueByKeys(value, [
    "staff_code",
    "staffCode",
    "employee_code",
    "employeeCode",
  ]);

  if (explicit) {
    return explicit;
  }

  return findValueByKeys(value?.data ?? value, ["code"]);
};

const fetchStaffCode = async (token) => {
  const response = await fetch(
    "https://wshr.hasaki.vn/api/news/token?app_id=4",
    {
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${token}`,
        Origin: "https://work.hasaki.vn",
        Referer: "https://work.hasaki.vn/",
        "User-Agent": "timesheet-app/1.0",
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  const rawBody = await response.text();

  if (!response.ok) {
    const error = new Error(
      `API lấy thông tin nhân viên trả về HTTP ${response.status}.`
    );
    error.statusCode = response.status;
    error.detail = rawBody.slice(0, 1000);
    throw error;
  }

  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = rawBody;
  }

  const staffCode = findStaffCode(payload);

  if (!staffCode) {
    const error = new Error(
      "Không tìm thấy staff_code trong response của API news/token."
    );
    error.statusCode = 502;
    error.detail = rawBody.slice(0, 1000);
    throw error;
  }

  return staffCode;
};

app.post("/api/timesheet", async (req, res) => {
  const token = normalizeToken(req.body?.token);
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);

  if (!token) {
    return res.status(400).json({ error: "Access token không được để trống." });
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: "Năm không hợp lệ." });
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Tháng không hợp lệ." });
  }

  const { fromDate, toDate, lastDay } = getMonthRange(year, month);
  const limit = Math.max(lastDay + 5, 35);

  try {
    const staffCode = await fetchStaffCode(token);

    const params = new URLSearchParams({
    location_id: LOCATION_ID,
    department_id: DEPARTMENT_ID,
    staff_code: staffCode,
    from_date: fromDate,
    to_date: toDate,
    limit: String(limit),
    page: "1",
    });

    const response = await fetch(
      `https://wshr.hasaki.vn/api/v2/timesheet?${params.toString()}`,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: `Bearer ${token}`,
          Origin: "https://hr.hasaki.vn",
          Referer: "https://hr.hasaki.vn/",
          "User-Agent": "timesheet-app/1.0",
        },
        signal: AbortSignal.timeout(15000),
      }
    );

    const rawBody = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `API chấm công trả về HTTP ${response.status}.`,
        detail: rawBody.slice(0, 1000),
      });
    }

    let payload;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(502).json({
        error: "API chấm công không trả về JSON hợp lệ.",
      });
    }

    const rows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];
    let totalWorkedSeconds = 0;
    let validDaysCount = 0;
    const details = [];
    const days = [];

    for (const row of rows) {
      if (row?.check_in == null || row?.check_out == null) {
        continue;
      }

      const checkIn = Number(row.check_in);
      const checkOut = Number(row.check_out);

      if (!Number.isFinite(checkIn) || !Number.isFinite(checkOut)) {
        continue;
      }

      const workedSeconds = checkOut - checkIn;

      if (workedSeconds < 0) {
        continue;
      }

      const diffSeconds = workedSeconds - TARGET_SECONDS_PER_DAY;

      totalWorkedSeconds += workedSeconds;
      validDaysCount++;

      const status =
        diffSeconds >= 0
          ? `+${formatTime(diffSeconds)} (Dư)`
          : `-${formatTime(diffSeconds)} (Thiếu)`;

      details.push(
        `[${row.date}] Làm: ${formatTime(workedSeconds)} | Chênh lệch: ${status}`
      );

      days.push({
        date: row.date ?? null,
        check_in: checkIn,
        check_out: checkOut,
        worked_seconds: workedSeconds,
        diff_seconds: diffSeconds,
      });
    }

    const totalTargetSeconds =
      validDaysCount * TARGET_SECONDS_PER_DAY;
    const diffTotalSeconds =
      totalWorkedSeconds - totalTargetSeconds;

    const output = [
      "=== CHI TIẾT CHẤM CÔNG HẰNG NGÀY ===",
      ...details,
      "",
      "================ KẾT QUẢ TỔNG HỢP ================",
      `• Số ngày tính toán: ${validDaysCount} ngày`,
      `• Tổng giờ chuẩn (${validDaysCount} ngày x ${TARGET_HOURS_PER_DAY}h): ${formatDuration(totalTargetSeconds)}`,
      `• Tổng giờ thực tế làm: ${formatDuration(totalWorkedSeconds)}`,
      diffTotalSeconds >= 0
        ? `=> KẾT QUẢ: Bạn đang DƯ ${formatDuration(diffTotalSeconds)} 🎉`
        : `=> KẾT QUẢ: Bạn đang THIẾU ${formatDuration(Math.abs(diffTotalSeconds))} ⚠️`,
    ].join("\n");

    return res.json({
      output,
      days,
      summary: {
        from_date: fromDate,
        to_date: toDate,
        valid_days: validDaysCount,
        target_seconds_per_day: TARGET_SECONDS_PER_DAY,
        total_worked_seconds: totalWorkedSeconds,
        total_target_seconds: totalTargetSeconds,
        difference_seconds: diffTotalSeconds,
        staff_code: staffCode,
      },
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 502;
    const message =
      error?.name === "TimeoutError"
        ? "API Hasaki phản hồi quá chậm."
        : error instanceof Error
          ? error.message
          : "Không thể kết nối tới API Hasaki.";

    return res.status(statusCode).json({
      error: message,
      detail: error?.detail || undefined,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Timesheet app listening on port ${PORT}`);
});

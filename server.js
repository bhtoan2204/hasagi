import express from "express";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Bỏ trống thì lấy theo profile của chính chủ token, chỉ set khi cần ép cứng.
const LOCATION_ID = process.env.LOCATION_ID || "";
const DEPARTMENT_ID = process.env.DEPARTMENT_ID || "";

// Chỉ dùng khi API không trả staff_schedule; bình thường định mức lấy theo span của ca.
const TARGET_HOURS_PER_DAY = 9;
const TARGET_SECONDS_PER_DAY = TARGET_HOURS_PER_DAY * 3600;

// Công ty chỉ có nghỉ phép 1 buổi = nửa ca (ca 9h -> 4h30), không có nghỉ nửa buổi.
const HALF_SESSION_RATIO = 0.5;

// Vắng từ 70% một buổi trở lên thì coi là nghỉ phép 1 buổi, không phải đi trễ / về sớm.
// Đối chiếu dữ liệu thật: ngày nghỉ buổi vắng 4h24–4h40, ngày trễ/sớm nhiều nhất chỉ 1h24.
const HALF_DETECT_RATIO = 0.7;

// Bit "về sớm" trong status, khớp 22/22 ngày: (status & 128) <=> check_out < staffsche_time_out.
const STATUS_LEFT_EARLY = 128;

const KIND_LABEL = {
  full: "Ngày thường",
  half_leave: "Phép 1 buổi",
  missing_punch: "Quên điểm danh",
};

const SESSION_LABEL = {
  morning: "nghỉ sáng",
  afternoon: "nghỉ chiều",
};

const MISSING_LABEL = {
  in: "thiếu giờ vào",
  out: "thiếu giờ ra",
  both: "thiếu cả giờ vào và giờ ra",
  invalid: "giờ ra không sau giờ vào",
};

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

  // `code` chỉ là phương án dự phòng, và phải bỏ qua lớp envelope ngoài cùng
  // vì ở đó `code` là HTTP status (vd. 200), không phải mã nhân viên.
  return findValueByKeys(value?.data ?? value, ["code"]);
};

const AVATAR_BASE = "https://hr-media.hasaki.vn/production/hr/";

const resolveAvatar = (profile, staffInfo) => {
  const direct = String(profile?.avatar || "").trim();

  if (/^https?:\/\//i.test(direct)) {
    return direct;
  }

  const relative = String(direct || staffInfo?.avatar || "").trim();

  if (!relative) {
    return null;
  }

  return AVATAR_BASE + relative.replace(/^\/+/, "");
};

const fetchProfile = async (token) => {
  const response = await fetch(
    "https://wshr.hasaki.vn/api/setting/user/profile?employee=1",
    {
      headers: {
        Accept: "*/*",
        "Accept-Language": "vi",
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

  const staffInfo = payload?.data?.staff_info ?? null;
  const profile = payload?.data?.profile ?? null;

  const staffCode =
    String(staffInfo?.code ?? "").trim() || findStaffCode(payload);

  if (!staffCode) {
    const error = new Error(
      "Không tìm thấy mã nhân viên trong response của API user/profile."
    );
    error.statusCode = 502;
    error.detail = rawBody.slice(0, 1000);
    throw error;
  }

  const departmentId = staffInfo?.staff_dept_id;
  const locationId = staffInfo?.staff_loc_id;

  return {
    staffCode,
    name: staffInfo?.staff_name || profile?.name || null,
    email: staffInfo?.staff_email || profile?.email || null,
    avatar: resolveAvatar(profile, staffInfo),
    departmentId:
      DEPARTMENT_ID || (departmentId == null ? "" : String(departmentId)),
    locationId: LOCATION_ID || (locationId == null ? "" : String(locationId)),
  };
};

// Tách một dòng chấm công thành các dữ kiện thô, chưa quy ra dư/thiếu.
const classifyDay = (row) => {
  const schedule = row?.staff_schedule || {};
  const scheduleIn = Number(schedule.staffsche_time_in);
  const scheduleOut = Number(schedule.staffsche_time_out);
  const hasSchedule =
    Number.isFinite(scheduleIn) &&
    Number.isFinite(scheduleOut) &&
    scheduleOut > scheduleIn;

  const spanSeconds = hasSchedule
    ? scheduleOut - scheduleIn
    : TARGET_SECONDS_PER_DAY;
  const halfSeconds = Math.round(spanSeconds * HALF_SESSION_RATIO);

  const checkIn = Number(row?.check_in);
  const checkOut = Number(row?.check_out);
  const hasCheckIn =
    row?.check_in != null && Number.isFinite(checkIn) && checkIn > 0;
  const hasCheckOut =
    row?.check_out != null && Number.isFinite(checkOut) && checkOut > 0;

  const base = {
    date: row?.date ?? null,
    shift: schedule.staffsche_shift ?? null,
    schedule_in: hasSchedule ? scheduleIn : null,
    schedule_out: hasSchedule ? scheduleOut : null,
    span_seconds: spanSeconds,
    half_seconds: halfSeconds,
    check_in: hasCheckIn ? checkIn : null,
    check_out: hasCheckOut ? checkOut : null,
    raw_status: Number.isFinite(Number(row?.status)) ? Number(row.status) : null,
    left_early_flag: (Number(row?.status) & STATUS_LEFT_EARLY) !== 0,
  };

  // Thiếu punch (hoặc cặp punch vô lý) thì phải làm phiếu quên điểm danh.
  if (!hasCheckIn || !hasCheckOut || checkOut <= checkIn) {
    const missing = !hasCheckIn && !hasCheckOut
      ? "both"
      : !hasCheckIn
        ? "in"
        : !hasCheckOut
          ? "out"
          : "invalid";

    return {
      ...base,
      kind: "missing_punch",
      missing,
      session: null,
      late_by: null,
      early_by: null,
      punched_seconds: 0,
    };
  }

  const punchedSeconds = checkOut - checkIn;
  const lateBy = hasSchedule ? Math.max(0, checkIn - scheduleIn) : 0;
  const earlyBy = hasSchedule ? Math.max(0, scheduleOut - checkOut) : 0;
  const detectSeconds = Math.round(halfSeconds * HALF_DETECT_RATIO);
  const isHalfLeave =
    hasSchedule && (lateBy >= detectSeconds || earlyBy >= detectSeconds);

  return {
    ...base,
    kind: isHalfLeave ? "half_leave" : "full",
    missing: null,
    session: isHalfLeave ? (lateBy >= earlyBy ? "morning" : "afternoon") : null,
    late_by: lateBy,
    early_by: earlyBy,
    punched_seconds: punchedSeconds,
  };
};

// Quy dữ kiện thô thành giờ làm / định mức / chênh lệch theo loại ngày.
// Frontend áp dụng đúng ba nhánh này khi người dùng đổi loại ngày bằng tay.
const resolveDay = (day, kind = day.kind) => {
  if (kind === "missing_punch") {
    // Phiếu quên điểm danh được duyệt: tính đủ định mức, không dư không thiếu.
    return {
      kind,
      worked_seconds: day.span_seconds,
      target_seconds: day.span_seconds,
      diff_seconds: 0,
    };
  }

  const targetSeconds =
    kind === "half_leave" ? day.span_seconds - day.half_seconds : day.span_seconds;

  return {
    kind,
    worked_seconds: day.punched_seconds,
    target_seconds: targetSeconds,
    diff_seconds: day.punched_seconds - targetSeconds,
  };
};

const describeDay = (day) => {
  const parts = [`[${day.date}]`];

  if (day.kind === "missing_punch") {
    parts.push(
      `${KIND_LABEL.missing_punch} (${MISSING_LABEL[day.missing] || "thiếu dữ liệu"})`,
      `| Tính đủ định mức: ${formatTime(day.target_seconds)}`,
      "| Chênh lệch: 0h 0m 0s"
    );

    return parts.join(" ");
  }

  if (day.kind === "half_leave") {
    parts.push(`${KIND_LABEL.half_leave} (${SESSION_LABEL[day.session] || "-"})`, "|");
  }

  parts.push(
    `Làm: ${formatTime(day.worked_seconds)}`,
    `| Định mức: ${formatTime(day.target_seconds)}`,
    `| Chênh lệch: ${
      day.diff_seconds >= 0
        ? `+${formatTime(day.diff_seconds)} (Dư)`
        : `-${formatTime(day.diff_seconds)} (Thiếu)`
    }`
  );

  return parts.join(" ");
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
    const profile = await fetchProfile(token);

    const params = new URLSearchParams({
      location_id: profile.locationId,
      department_id: profile.departmentId,
      staff_code: profile.staffCode,
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

    const days = rows
      .map((row) => {
        const facts = classifyDay(row);

        return { ...facts, ...resolveDay(facts) };
      })
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

    const counts = { full: 0, half_leave: 0, missing_punch: 0 };
    let totalWorkedSeconds = 0;
    let totalTargetSeconds = 0;

    for (const day of days) {
      counts[day.kind]++;
      totalWorkedSeconds += day.worked_seconds;
      totalTargetSeconds += day.target_seconds;
    }

    const diffTotalSeconds = totalWorkedSeconds - totalTargetSeconds;
    const missingPunchDays = days
      .filter((day) => day.kind === "missing_punch")
      .map((day) => day.date);
    const halfLeaveDays = days
      .filter((day) => day.kind === "half_leave")
      .map((day) => day.date);

    const output = [
      "=== CHI TIẾT CHẤM CÔNG HẰNG NGÀY ===",
      ...days.map(describeDay),
      "",
      "================ KẾT QUẢ TỔNG HỢP ================",
      `• Số ngày tính toán: ${days.length} ngày`,
      `• Trong đó: ${counts.full} ngày thường, ${counts.half_leave} ngày phép 1 buổi, ${counts.missing_punch} ngày quên điểm danh`,
      `• Tổng giờ chuẩn: ${formatDuration(totalTargetSeconds)}`,
      `• Tổng giờ thực tế làm: ${formatDuration(totalWorkedSeconds)}`,
      ...(missingPunchDays.length
        ? [
            "",
            `⚑ CẦN LÀM PHIẾU QUÊN ĐIỂM DANH: ${missingPunchDays.join(", ")}`,
            "  (đang được tính đủ định mức, nếu phiếu không được duyệt thì số liệu sẽ lệch)",
          ]
        : []),
      "",
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
        valid_days: days.length,
        day_counts: counts,
        half_leave_days: halfLeaveDays,
        missing_punch_days: missingPunchDays,
        target_seconds_per_day: TARGET_SECONDS_PER_DAY,
        total_worked_seconds: totalWorkedSeconds,
        total_target_seconds: totalTargetSeconds,
        difference_seconds: diffTotalSeconds,
        staff_code: profile.staffCode,
        staff_name: profile.name,
        staff_email: profile.email,
        staff_avatar: profile.avatar,
        department_id: profile.departmentId,
        location_id: profile.locationId,
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

// Chỉ mở port khi chạy trực tiếp, để file này import được vào test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Timesheet app listening on port ${PORT}`);
  });
}

export { classifyDay, resolveDay, fetchProfile, findStaffCode, resolveAvatar };

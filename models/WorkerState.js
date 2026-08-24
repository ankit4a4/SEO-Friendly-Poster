const mongoose = require("mongoose");

// Singleton document (_id is always "worker") that holds the shared
// start/stop state for auto-posting. Living in the DB instead of a plain
// in-memory variable means every dashboard - across all 3-4 people who log
// in - sees the exact same live state, and it survives a server restart.
// It stays running regardless of open tabs; only Stop, or the midnight
// auto-stop in server.js, pauses it again.
module.exports = mongoose.model("WorkerState", new mongoose.Schema({
  _id: { type: String, default: "worker" },
  paused: { type: Boolean, default: false },
  startedBy: { type: String, default: null }, // username that last pressed Start, for reference only
}));

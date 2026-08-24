// Regions available for the "type a topic instead of a URL" source feature
// (see services/scraper.js -> topicToGoogleNewsUrl). Each maps to the
// hl/gl/ceid params Google News RSS search expects. "GLOBAL" intentionally
// has no gl/ceid restriction, so results aren't biased toward any one
// country's local publishers.
const REGIONS = [
  { code: "GLOBAL", label: "Global", hl: "en", gl: "", ceid: "" },
  { code: "IN", label: "India", hl: "en-IN", gl: "IN", ceid: "IN:en" },
  { code: "US", label: "USA", hl: "en-US", gl: "US", ceid: "US:en" },
  { code: "AE", label: "Middle East (UAE)", hl: "en-AE", gl: "AE", ceid: "AE:en" },
  { code: "SA", label: "Saudi Arabia", hl: "en-SA", gl: "SA", ceid: "SA:en" },
  { code: "GB", label: "UK", hl: "en-GB", gl: "GB", ceid: "GB:en" },
  { code: "CA", label: "Canada", hl: "en-CA", gl: "CA", ceid: "CA:en" },
  { code: "AU", label: "Australia", hl: "en-AU", gl: "AU", ceid: "AU:en" },
  { code: "SG", label: "Singapore", hl: "en-SG", gl: "SG", ceid: "SG:en" },
  { code: "ZA", label: "South Africa", hl: "en-ZA", gl: "ZA", ceid: "ZA:en" },
  { code: "NG", label: "Nigeria", hl: "en-NG", gl: "NG", ceid: "NG:en" },
  { code: "PK", label: "Pakistan", hl: "en-PK", gl: "PK", ceid: "PK:en" },
  { code: "BD", label: "Bangladesh", hl: "en-BD", gl: "BD", ceid: "BD:en" },
  { code: "MY", label: "Malaysia", hl: "en-MY", gl: "MY", ceid: "MY:en" },
  { code: "PH", label: "Philippines", hl: "en-PH", gl: "PH", ceid: "PH:en" },
  { code: "IE", label: "Ireland", hl: "en-IE", gl: "IE", ceid: "IE:en" },
  { code: "NZ", label: "New Zealand", hl: "en-NZ", gl: "NZ", ceid: "NZ:en" },
  { code: "KE", label: "Kenya", hl: "en-KE", gl: "KE", ceid: "KE:en" },
];

function getRegion(code) {
  return REGIONS.find((r) => r.code === code) || REGIONS.find((r) => r.code === "GLOBAL");
}

module.exports = { REGIONS, getRegion };
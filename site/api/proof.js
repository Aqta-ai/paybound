// Read-only proxy for Seal's public transparency log, limited to Paybound's own records.
const IDS = new Set(["e19f9374-d2ad-4ec1-9dd2-9c7660b50fc4", "80cf13c1-7409-4b2f-bb87-3e15b4712b12", "f608370b-2476-4332-b53a-e3bf2e8a765d", "6f2ae4df-c01f-4b3e-97fd-9f2677121829", "06732a8e-e739-4451-bf86-45838dff76c9", "245d046f-9ebe-48c5-af05-9ecbd3ad4c5d", "f026c5bf-6974-4d34-ad9c-45b0cc2b7ef4", "3d3711fa-dfdf-488f-991f-7d315c16d070", "6f6d575c-b683-47be-864e-c3b3a021531a", "9e41a459-5106-4981-8f90-3110bb9f3ff8"]);
export default async function handler(req, res) {
  const id = String(req.query.id || "");
  if (!IDS.has(id)) return res.status(404).json({ error: "unknown record" });
  const r = await fetch("https://api.aqta.ai/v1/public/transparency/proof/" + encodeURIComponent(id));
  if (!r.ok) return res.status(502).json({ error: "Seal log unavailable" });
  const j = await r.json();
  res.setHeader("cache-control", "s-maxage=300");
  res.status(200).json({ record_type: j.record_type, leaf_index: j.leaf_index, tree_size: j.tree_size });
}

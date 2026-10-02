// The layout worker: runs layouts off the page's thread, so a big graph's layout never freezes the page. It keeps
// the latest structure it was sent (a request brings one only when it's different), rebuilding its working graph
// only when that changes, and answers each layout request with homes and routing (layout-job.js).
//
// It takes one request at a time (the layouter waits for each answer before sending the next), and says it has
// picked a request up before working on it, so the layouter can tell a worker that's busy from one that never
// started.

import { graphFromStructure, runLayout } from "./layout-job.js";

let current = null; // { version, graph }: the structure the layouts are for

self.onmessage = ({ data }) => {
  if (data.type !== "layout") return;
  self.postMessage({ id: data.id, started: true });
  try {
    if (data.structure)
      current = {
        version: data.version,
        graph: graphFromStructure(data.structure),
      };
    // A layout is only ever run on the structure it was asked for.
    if (current?.version !== data.version)
      throw new Error("layout worker: no structure for this version");
    const result = runLayout(
      current.graph,
      data.layout,
      data.options,
      data.sizing,
    );
    const transfer = [result.homeX.buffer, result.homeY.buffer];
    if (result.routing.bends)
      transfer.push(
        result.routing.bends.edges.buffer,
        result.routing.bends.start.buffer,
        result.routing.bends.xy.buffer,
      );
    self.postMessage({ id: data.id, result }, transfer);
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};

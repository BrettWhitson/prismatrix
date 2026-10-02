// The layout worker: runs layouts off the page's thread, so a big graph's layout never freezes the page. It keeps
// the latest structure it was sent (rebuilding its working graph only when that changes) and answers each layout
// request with homes and routing (layout-job.js).

import { graphFromStructure, runLayout } from "./layout-job.js";

let structure = null; // { version, graph }

self.onmessage = ({ data }) => {
  if (data.type === "structure") {
    structure = { version: data.version, source: data.structure, graph: null };
    return;
  }
  if (data.type === "layout") {
    try {
      if (!structure || structure.version !== data.version)
        throw new Error("layout worker: no structure for this version");
      structure.graph ??= graphFromStructure(structure.source);
      const result = runLayout(
        structure.graph,
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
  }
};

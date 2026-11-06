import { parentPort, workerData } from "node:worker_threads";
import { buildConsensusRows, type MemberSentence } from "./ebook-set-aligner.ts";

import { CONSENSUS_MAX_CELLS } from "./ebook-set-consensus-limits.ts";

if (!parentPort) throw new Error("Consensus worker requires a parent port.");
parentPort.postMessage(buildConsensusRows(workerData as MemberSentence[][], CONSENSUS_MAX_CELLS));

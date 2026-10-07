// Frontend data access for souls: one RPC read per surface, kept current by
// the server's "souls-changed" signal (which fires for writes from this page,
// another window, `bb souls`, or an agent tool).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { moodFor, type Activity, type Mood } from "../motion";
import type { Soul, SoulSummary, ThreadSoulState } from "../shared";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `useRealtime` with a handler that always sees the latest render: it reads
 * through a ref, so a thread switch in the same pane never filters on the
 * old thread id, whether or not the host re-subscribes on a new handler.
 */
export function useSignal(
  channel: string,
  handler: (payload: unknown) => void,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  const stable = useCallback((payload: unknown) => latest.current(payload), []);
  useRealtime(channel, stable);
}

/** The whole library; late reads cannot overwrite a newer signal or unmounted surface. */
export function useSouls() {
  const rpc = useRpc<typeof rpcContract>();
  const [souls, setSouls] = useState<SoulSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++ticket.current;
    setError(null);
    rpc.call("souls_list").then(
      (result) => {
        if (mine === ticket.current) {
          setSouls(result.souls);
          setError(null);
        }
      },
      (cause) => {
        if (mine === ticket.current) setError(message(cause));
      },
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    return () => {
      ++ticket.current;
    };
  }, [refetch]);
  useSignal("souls-changed", refetch);
  return { rpc, souls, error, setError, refetch };
}

/** The soul one thread runs as, or null. `threadId` null means "no thread". */
export function useThreadSoul(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ThreadSoulState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ticket = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++ticket.current;
    if (threadId === null) {
      setState(null);
      setLoaded(true);
      return;
    }
    rpc.call("souls_thread_get", { threadId }).then(
      (result) => {
        if (mine !== ticket.current) return;
        setState(result);
        setLoaded(true);
      },
      () => {
        if (mine === ticket.current) setLoaded(true);
      },
    );
  }, [rpc, threadId]);
  useEffect(() => {
    setState(null);
    setLoaded(false);
    refetch();
    return () => {
      ++ticket.current;
    };
  }, [refetch]);
  useSignal("souls-changed", refetch);
  useSignal("souls-session-changed", (payload) => {
    if ((payload as { threadId?: unknown })?.threadId === threadId) refetch();
  });
  return {
    soul: state?.soul ?? null,
    allowDelegation: state?.allowDelegation ?? false,
    state,
    loaded,
    refetch,
  };
}

type PendingSelection = {
  soul: SoulSummary | null;
  allowDelegation: boolean;
  /** When the choice lapses unused (epoch ms); null when nothing is pending. */
  expiresAt: number | null;
};

const NO_PENDING: PendingSelection = {
  soul: null,
  allowDelegation: false,
  expiresAt: null,
};

/** The soul chosen on the compose screen, waiting for the thread it will bind to. */
export function usePendingSoul() {
  const rpc = useRpc<typeof rpcContract>();
  const [selection, setSelection] = useState<PendingSelection>(NO_PENDING);
  const refetch = useCallback(() => {
    rpc.call("souls_pending_get").then(
      (result) => setSelection(result),
      () => setSelection(NO_PENDING),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useSignal("souls-changed", refetch);
  // The server drops an unused choice after its window; ask again just after,
  // so nothing keeps promising a soul the next thread will not get.
  useEffect(() => {
    if (selection.expiresAt === null) return;
    const timer = setTimeout(
      refetch,
      Math.max(0, selection.expiresAt - Date.now()) + 500,
    );
    return () => clearTimeout(timer);
  }, [selection.expiresAt, refetch]);
  return selection;
}

/** What a soul thread is doing now (see motion.ts); null when idle or unknown. */
export function useSoulActivity(threadId: string | null): Activity | null {
  const rpc = useRpc<typeof rpcContract>();
  const [activity, setActivity] = useState<Activity | null>(null);
  useEffect(() => {
    setActivity(null);
    if (threadId === null) return;
    let live = true;
    rpc.call("souls_activity_get", { threadId }).then(
      (result) => {
        if (live) setActivity(result.activity);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId]);
  useSignal("souls-activity", (payload) => {
    const update = payload as { threadId?: unknown; activity?: unknown };
    if (update?.threadId !== threadId) return;
    setActivity(
      typeof update.activity === "string"
        ? (update.activity as Activity)
        : null,
    );
  });
  return activity;
}

/**
 * The mood a thread's soul portrait shows: the host's live thread view says
 * whether it is blocked on the user, failed or starting; the server says
 * what the work is.
 */
export function useThreadMood(threadId: string | null): Mood {
  const { threads } = experimental_useSidebarThreads();
  const activity = useSoulActivity(threadId);
  const live =
    threadId === null
      ? undefined
      : threads.find((thread) => thread.id === threadId);
  return moodFor(
    live === undefined
      ? null
      : {
          status: live.status,
          runtimeStatus: live.runtimeStatus,
          hasPendingInteraction: live.hasPendingInteraction,
        },
    activity,
  );
}

type CompactionReminder = { pending: boolean; seq: number | null };
const NO_REMINDER: CompactionReminder = { pending: false, seq: null };

/**
 * Whether a compaction's persona reminder is waiting for this thread's next
 * message, and which compaction (by event sequence) it belongs to.
 */
export function useCompactionReminder(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [reminder, setReminder] = useState<CompactionReminder>(NO_REMINDER);
  const ticket = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++ticket.current;
    if (threadId === null) {
      setReminder(NO_REMINDER);
      return;
    }
    rpc.call("souls_compaction_get", { threadId }).then(
      (result) => {
        if (mine === ticket.current) setReminder(result);
      },
      () => {
        if (mine === ticket.current) setReminder(NO_REMINDER);
      },
    );
  }, [rpc, threadId]);
  useEffect(() => {
    refetch();
    return () => {
      ++ticket.current;
    };
  }, [refetch]);
  useSignal("souls-session-changed", (payload) => {
    if ((payload as { threadId?: unknown })?.threadId === threadId) refetch();
  });
  return reminder;
}

/** Which threads select which soul. Unknown usage is not a zero count. */
export function useSoulSelectionState() {
  const rpc = useRpc<typeof rpcContract>();
  const [counts, setCounts] = useState<Map<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++ticket.current;
    rpc.call("souls_selections").then(
      (result) => {
        if (mine !== ticket.current) return;
        const next = new Map<string, number>();
        for (const selection of result.selections)
          next.set(selection.soul.id, (next.get(selection.soul.id) ?? 0) + 1);
        setCounts(next);
        setError(null);
      },
      (cause) => {
        if (mine !== ticket.current) return;
        setCounts(null);
        setError(message(cause));
      },
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    return () => {
      ++ticket.current;
    };
  }, [refetch]);
  useSignal("souls-changed", refetch);
  return { counts, error, refetch };
}

const EMPTY_COUNTS = new Map<string, number>();
/** Legacy consumers need only the count map, not the library's loading state. */
export function useSoulSelections() {
  return useSoulSelectionState().counts ?? EMPTY_COUNTS;
}

/** A full persona plus explicit loading/error state for the library. */
export function useSoulResource(idOrName: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    key: string | null;
    soul: Soul | null;
    error: string | null;
  }>({ key: null, soul: null, error: null });
  const ticket = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++ticket.current;
    if (idOrName === null) {
      setState({ key: null, soul: null, error: null });
      return;
    }
    setState((current) =>
      current.error === null ? current : { ...current, error: null },
    );
    rpc.call("souls_get", { idOrName }).then(
      (result) => {
        if (ticket.current === mine)
          setState({ key: idOrName, soul: result.soul, error: null });
      },
      (cause) => {
        if (ticket.current === mine)
          setState({ key: idOrName, soul: null, error: message(cause) });
      },
    );
  }, [rpc, idOrName]);
  useEffect(() => {
    refetch();
    return () => {
      ++ticket.current;
    };
  }, [refetch]);
  useSignal("souls-changed", refetch);
  const current = state.key === idOrName;
  return {
    soul: current ? state.soul : null,
    error: current ? state.error : null,
    refetch,
  };
}

/** Existing consumers only need the current persona, never a previous selection. */
export function useSoul(idOrName: string | null) {
  return useSoulResource(idOrName).soul;
}

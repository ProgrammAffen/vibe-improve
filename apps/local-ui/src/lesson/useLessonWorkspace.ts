import { useCallback, useEffect, useRef, useState } from "react";
import { lessonService } from "./service";
import type { LessonIdentity, LessonWorkspace } from "./types";

/** A single serialized save queue; edits made during a save are never replaced by its reply. */
export function useLessonWorkspace(identity: LessonIdentity) {
  const [workspace, setWorkspace] = useState<LessonWorkspace | null>(null);
  const [status, setStatus] = useState<
    "loading" | "saved" | "dirty" | "saving" | "error"
  >("loading");
  const [error, setError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const current = useRef<LessonWorkspace | null>(null),
    generation = useRef(0),
    savedGeneration = useRef(0);
  const queue = useRef<Promise<boolean> | null>(null),
    mounted = useRef(true),
    conflict = useRef(false);
  const key = `${identity.projectId}/${identity.routeId}/${identity.nodeId}`;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    setStatus("loading");setError("");
    void lessonService.read(identity).then(
      (value) => {
        if (!active) return;
        current.current = value;
        setWorkspace(value);
        setStatus("saved");
      },
      (cause) => {
        if (active) {
          setError(String(cause));
          setStatus("error");
        }
      },
    );
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [key, readAttempt]);
  const update = useCallback(
    (change: (value: LessonWorkspace) => LessonWorkspace) => {
      if (!current.current) return;
      const next = change(current.current);
      if (next === current.current) return;
      current.current = next;
      generation.current++;
      setWorkspace(next);
      setStatus("dirty");
    },
    [],
  );
  const flush = useCallback(async (): Promise<boolean> => {
    if (queue.current) return queue.current;
    if (!current.current || conflict.current) return false;
    if (generation.current === savedGeneration.current) return true;
    const run = async () => {
      try {
        while (generation.current !== savedGeneration.current) {
          const snapshot = current.current!,
            version = generation.current;
          if (mounted.current) setStatus("saving");
          const saved = await lessonService.save(
            identity,
            snapshot.revision,
            snapshot,
          );
          // A newer edit keeps its content, receiving only the successful revision.
          current.current = { ...current.current!, revision: saved.revision };
          savedGeneration.current = version;
          if (mounted.current) setWorkspace(current.current);
        }
        if (mounted.current) {
          setError("");
          setStatus("saved");
        }
        return true;
      } catch (cause) {
        conflict.current = String(cause).includes("LESSON_CONFLICT");
        if (mounted.current) {
          setError(String(cause));
          setStatus("error");
        }
        return false;
      } finally {
        queue.current = null;
      }
    };
    queue.current = run();
    return queue.current;
  }, [key]);
  useEffect(() => {
    if (status !== "dirty") return;
    const timer = window.setTimeout(() => void flush(), 900);
    return () => window.clearTimeout(timer);
  }, [workspace, status, flush]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (generation.current !== savedGeneration.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  // Streamed replies can keep changing faster than the debounce delay. Checkpoint
  // them periodically as well, so a crash does not erase an entire long reply.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!conflict.current && generation.current !== savedGeneration.current)
        void flush();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [flush]);
  return {
    workspace,
    update,
    flush,
    status,
    error,
    current,
    retryRead: () => {if (!current.current) setReadAttempt(value => value + 1);},
    dirty: generation.current !== savedGeneration.current,
  };
}

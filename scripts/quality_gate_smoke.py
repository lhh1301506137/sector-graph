import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Smoke test for: refresh -> data-quality gate -> scoring publish gate."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:18000", help="API base url")
    parser.add_argument("--start-server", action="store_true", help="Start uvicorn for this test run")
    parser.add_argument("--python", default=sys.executable, help="Python executable used to start uvicorn")
    parser.add_argument("--host", default="127.0.0.1", help="Host used when --start-server is enabled")
    parser.add_argument("--port", type=int, default=18000, help="Port used when --start-server is enabled")
    parser.add_argument("--source", default="sina", help="Refresh source passed to /api/sectors/refresh")
    parser.add_argument("--target-date", default="", help="Optional target date: YYYY-MM-DD")
    parser.add_argument("--timeout-sec", type=float, default=40.0, help="HTTP timeout in seconds")
    parser.add_argument("--skip-refresh", action="store_true", help="Skip /api/sectors/refresh call")
    parser.add_argument(
        "--exercise-blocked-case",
        action="store_true",
        help="Also force a blocked gate case by temporarily raising quality_min_total_rows, then restore config.",
    )
    parser.add_argument(
        "--blocked-min-total-padding",
        type=int,
        default=1,
        help="Forced min_total_rows will be total_rows + padding in blocked-case validation.",
    )
    parser.add_argument(
        "--exercise-failed-rows-case",
        action="store_true",
        help="Force failed rows by lowering turnover threshold, verify failed-details API and publish blocking, then restore.",
    )
    parser.add_argument(
        "--failed-turnover-threshold",
        type=float,
        default=1.0,
        help="Temporary quality_turnover_abs_max used in failed-rows case.",
    )
    parser.add_argument(
        "--failed-case-limit",
        type=int,
        default=5,
        help="Limit used when querying /api/data-quality/failed in failed-rows case.",
    )
    parser.add_argument(
        "--expect-publish-allowed",
        choices=["auto", "true", "false"],
        default="auto",
        help="Expected publish gate result. auto = infer from API snapshot.",
    )
    return parser.parse_args()


def _json_dumps(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def http_json(
    method: str,
    url: str,
    payload: Optional[dict] = None,
    timeout_sec: float = 40.0,
) -> tuple[int, Any]:
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        body = _json_dumps(payload)
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url=url, data=body, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read()
            status = int(resp.status)
            text = raw.decode("utf-8", errors="replace")
            try:
                return status, json.loads(text)
            except Exception:
                return status, {"raw": text}
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(text)
        except Exception:
            data = {"raw": text}
        return int(e.code), data
    except urllib.error.URLError as e:
        return 0, {"error": str(e)}
    except (TimeoutError, socket.timeout) as e:
        return 0, {"error": f"timeout: {e}"}


def wait_health(base_url: str, timeout_sec: float = 30.0) -> None:
    started = time.time()
    last_error = None
    while time.time() - started < timeout_sec:
        try:
            status, data = http_json("GET", f"{base_url}/api/health", timeout_sec=5.0)
            if status == 200 and isinstance(data, dict) and data.get("status") == "ok":
                return
            last_error = f"health not ready: status={status}, data={data}"
        except Exception as e:  # pragma: no cover
            last_error = str(e)
        time.sleep(1)
    raise RuntimeError(f"Server health check timeout. Last error: {last_error}")


def normalize_bool_text(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def get_algo_config(base_url: str, timeout_sec: float) -> dict:
    status, data = http_json("GET", f"{base_url}/api/config", timeout_sec=timeout_sec)
    if status != 200 or not isinstance(data, dict):
        raise RuntimeError(f"/api/config failed: status={status}, data={data}")
    return data.get("algo") if isinstance(data.get("algo"), dict) else {}


def get_algo_value(base_url: str, key: str, default: str, timeout_sec: float) -> str:
    algo = get_algo_config(base_url, timeout_sec=timeout_sec)
    raw = str(algo.get(key, default)).strip()
    return raw or default


def set_algo_values(base_url: str, values: dict[str, str], timeout_sec: float) -> None:
    payload = {"algo": {k: str(v) for k, v in values.items()}}
    status, data = http_json("POST", f"{base_url}/api/config", payload=payload, timeout_sec=timeout_sec)
    if status != 200:
        raise RuntimeError(f"/api/config update failed: status={status}, data={data}")
    if isinstance(data, dict) and str(data.get("status", "ok")).lower() not in {"ok", "success", "true", "1"}:
        raise RuntimeError(f"/api/config update unexpected response: {data}")


def refresh_with_retry(
    base_url: str,
    source: str,
    timeout_sec: float,
    max_attempts: int = 3,
    retry_delay_sec: float = 2.0,
) -> tuple[int, Any]:
    payload = {"source": source, "skip_save": 0}
    last_status = 0
    last_data: Any = {"error": "refresh not started"}
    for attempt in range(1, max_attempts + 1):
        status, data = http_json(
            "POST",
            f"{base_url}/api/sectors/refresh",
            payload=payload,
            timeout_sec=timeout_sec,
        )
        if status == 200:
            return status, data
        last_status, last_data = status, data
        if attempt < max_attempts:
            time.sleep(retry_delay_sec)
    return last_status, last_data


def main() -> int:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    proc: Optional[subprocess.Popen] = None
    out_file = None
    err_file = None

    if args.start_server:
        base_url = f"http://{args.host}:{args.port}"
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        out_path = os.path.join(root, "tmp_quality_gate_smoke.out.log")
        err_path = os.path.join(root, "tmp_quality_gate_smoke.err.log")
        out_file = open(out_path, "w", encoding="utf-8")
        err_file = open(err_path, "w", encoding="utf-8")
        proc = subprocess.Popen(
            [args.python, "-m", "uvicorn", "server.app:app", "--host", args.host, "--port", str(args.port)],
            cwd=root,
            stdout=out_file,
            stderr=err_file,
        )
        wait_health(base_url, timeout_sec=35.0)

    try:
        # 1) health
        health_status, health_data = http_json("GET", f"{base_url}/api/health", timeout_sec=args.timeout_sec)
        if health_status != 200:
            print(f"[FAIL] /api/health status={health_status} data={health_data}")
            return 1

        # 2) refresh (optional)
        refresh_status, refresh_data = 200, {"skipped": True}
        if not args.skip_refresh:
            refresh_status, refresh_data = refresh_with_retry(
                base_url=base_url,
                source=args.source,
                timeout_sec=args.timeout_sec,
            )
            if refresh_status != 200:
                print(f"[FAIL] /api/sectors/refresh status={refresh_status} data={refresh_data}")
                return 1

        # 3) latest quality snapshot
        dq_url = f"{base_url}/api/data-quality/latest"
        if args.target_date:
            dq_url += f"?target_date={urllib.parse.quote(args.target_date)}"
        dq_status, dq_data = http_json("GET", dq_url, timeout_sec=args.timeout_sec)
        if dq_status != 200 or not isinstance(dq_data, dict):
            print(f"[FAIL] /api/data-quality/latest status={dq_status} data={dq_data}")
            return 1

        trend_status, trend_data = http_json(
            "GET",
            f"{base_url}/api/data-quality/trend?days=7",
            timeout_sec=args.timeout_sec,
        )
        if trend_status != 200 or not isinstance(trend_data, dict):
            print(f"[FAIL] /api/data-quality/trend status={trend_status} data={trend_data}")
            return 1
        trend_items = trend_data.get("items")
        if not isinstance(trend_items, list):
            print(f"[FAIL] /api/data-quality/trend invalid items: {trend_data}")
            return 1
        if trend_items:
            first_item = trend_items[0] if isinstance(trend_items[0], dict) else {}
            failure_buckets = first_item.get("failure_buckets")
            if not isinstance(failure_buckets, dict):
                print(f"[FAIL] /api/data-quality/trend missing failure_buckets: item={first_item}")
                return 1
            required_bucket_keys = {
                "missing_rows",
                "anomaly_rows",
                "invalid_rows",
                "fallback_rows",
                "other_rows",
                "missing_ratio",
                "anomaly_ratio",
                "invalid_ratio",
                "fallback_ratio",
                "other_ratio",
            }
            missing_keys = sorted([k for k in required_bucket_keys if k not in failure_buckets])
            if missing_keys:
                print(
                    "[FAIL] /api/data-quality/trend failure_buckets missing keys: "
                    f"{missing_keys}, item={first_item}"
                )
                return 1

        publish_allowed = bool(dq_data.get("publish_allowed", False))
        if args.expect_publish_allowed != "auto":
            expected = normalize_bool_text(args.expect_publish_allowed)
            if publish_allowed != expected:
                print(
                    "[FAIL] publish_allowed mismatch: "
                    f"expected={expected} actual={publish_allowed} snapshot={json.dumps(dq_data, ensure_ascii=False)}"
                )
                return 1

        # 4) scoring publish gate
        scoring_payload = {"publish": True}
        if args.target_date:
            scoring_payload["target_date"] = args.target_date
        score_status, score_data = http_json(
            "POST",
            f"{base_url}/api/scoring/run",
            payload=scoring_payload,
            timeout_sec=args.timeout_sec,
        )

        if publish_allowed and score_status != 200:
            print(f"[FAIL] publish_allowed=true but scoring status={score_status} data={score_data}")
            return 1
        if (not publish_allowed) and score_status != 400:
            print(f"[FAIL] publish_allowed=false but scoring status={score_status} data={score_data}")
            return 1

        blocked_case_summary = None
        if args.exercise_blocked_case:
            original_min_total = None
            restore_error = None
            try:
                original_min_total = get_algo_value(
                    base_url,
                    "quality_min_total_rows",
                    default="1",
                    timeout_sec=args.timeout_sec,
                )
                base_total_rows = int(dq_data.get("total_rows") or 0)
                forced_min_total = max(1, base_total_rows + max(1, int(args.blocked_min_total_padding)))
                set_algo_values(
                    base_url,
                    {"quality_min_total_rows": str(forced_min_total)},
                    timeout_sec=args.timeout_sec,
                )

                dq_block_status, dq_block_data = http_json("GET", dq_url, timeout_sec=args.timeout_sec)
                if dq_block_status != 200 or not isinstance(dq_block_data, dict):
                    print(f"[FAIL] blocked-case /api/data-quality/latest status={dq_block_status} data={dq_block_data}")
                    return 1
                if bool(dq_block_data.get("publish_allowed", True)):
                    print(f"[FAIL] blocked-case expected publish_allowed=false but got true: {dq_block_data}")
                    return 1

                blocked_rules = []
                for item in dq_block_data.get("publish_blocked_reasons") or []:
                    if isinstance(item, dict):
                        blocked_rules.append(str(item.get("rule", "")).strip())
                if "min_total_rows" not in blocked_rules:
                    print(f"[FAIL] blocked-case missing min_total_rows rule: {dq_block_data}")
                    return 1

                score_block_status, score_block_data = http_json(
                    "POST",
                    f"{base_url}/api/scoring/run",
                    payload=scoring_payload,
                    timeout_sec=args.timeout_sec,
                )
                if score_block_status != 400:
                    print(
                        "[FAIL] blocked-case expected /api/scoring/run status=400 "
                        f"but got {score_block_status}, data={score_block_data}"
                    )
                    return 1

                blocked_case_summary = {
                    "forced_min_total_rows": forced_min_total,
                    "blocked_publish_allowed": bool(dq_block_data.get("publish_allowed", False)),
                    "blocked_rules": blocked_rules,
                    "blocked_scoring_status": score_block_status,
                }
            finally:
                if original_min_total is not None:
                    try:
                        set_algo_values(
                            base_url,
                            {"quality_min_total_rows": original_min_total},
                            timeout_sec=args.timeout_sec,
                        )
                    except Exception as e:  # pragma: no cover
                        restore_error = str(e)

            if restore_error:
                print(f"[FAIL] blocked-case restore config failed: {restore_error}")
                return 1

            dq_restore_status, dq_restore_data = http_json("GET", dq_url, timeout_sec=args.timeout_sec)
            if dq_restore_status != 200 or not isinstance(dq_restore_data, dict):
                print(f"[FAIL] blocked-case restore snapshot failed: status={dq_restore_status}, data={dq_restore_data}")
                return 1
            restored_publish_allowed = bool(dq_restore_data.get("publish_allowed", False))
            if restored_publish_allowed != publish_allowed:
                print(
                    "[FAIL] blocked-case restore mismatch: "
                    f"expected publish_allowed={publish_allowed}, actual={restored_publish_allowed}, "
                    f"snapshot={dq_restore_data}"
                )
                return 1
            blocked_case_summary["restored_publish_allowed"] = restored_publish_allowed

        failed_rows_case_summary = None
        if args.exercise_failed_rows_case:
            original_values = {}
            restore_error = None
            try:
                original_values = {
                    "quality_turnover_abs_max": get_algo_value(
                        base_url,
                        "quality_turnover_abs_max",
                        default="80",
                        timeout_sec=args.timeout_sec,
                    ),
                    "quality_max_failed_rows": get_algo_value(
                        base_url,
                        "quality_max_failed_rows",
                        default="0",
                        timeout_sec=args.timeout_sec,
                    ),
                    "quality_min_total_rows": get_algo_value(
                        base_url,
                        "quality_min_total_rows",
                        default="1",
                        timeout_sec=args.timeout_sec,
                    ),
                }

                set_algo_values(
                    base_url,
                    {
                        "quality_turnover_abs_max": str(args.failed_turnover_threshold),
                        "quality_max_failed_rows": "0",
                        "quality_min_total_rows": "1",
                    },
                    timeout_sec=args.timeout_sec,
                )

                refresh_case_status, refresh_case_data = refresh_with_retry(
                    base_url=base_url,
                    source=args.source,
                    timeout_sec=args.timeout_sec,
                )
                if refresh_case_status != 200:
                    print(
                        "[FAIL] failed-rows-case refresh failed: "
                        f"status={refresh_case_status}, data={refresh_case_data}"
                    )
                    return 1

                dq_failed_status, dq_failed_data = http_json("GET", dq_url, timeout_sec=args.timeout_sec)
                if dq_failed_status != 200 or not isinstance(dq_failed_data, dict):
                    print(
                        "[FAIL] failed-rows-case /api/data-quality/latest failed: "
                        f"status={dq_failed_status}, data={dq_failed_data}"
                    )
                    return 1

                failed_rows_value = int(dq_failed_data.get("failed_rows") or 0)
                if failed_rows_value <= 0:
                    print(f"[FAIL] failed-rows-case expected failed_rows>0 but got snapshot={dq_failed_data}")
                    return 1
                if bool(dq_failed_data.get("publish_allowed", True)):
                    print(f"[FAIL] failed-rows-case expected publish_allowed=false but got true: {dq_failed_data}")
                    return 1

                failed_rules = []
                for item in dq_failed_data.get("publish_blocked_reasons") or []:
                    if isinstance(item, dict):
                        failed_rules.append(str(item.get("rule", "")).strip())
                if "failed_rows_threshold" not in failed_rules:
                    print(f"[FAIL] failed-rows-case missing failed_rows_threshold rule: {dq_failed_data}")
                    return 1

                failed_limit = max(1, int(args.failed_case_limit))
                failed_query = [f"limit={failed_limit}"]
                if args.target_date:
                    failed_query.append(f"target_date={urllib.parse.quote(args.target_date)}")
                failed_url = f"{base_url}/api/data-quality/failed?{'&'.join(failed_query)}"
                failed_detail_status, failed_detail_data = http_json("GET", failed_url, timeout_sec=args.timeout_sec)
                if failed_detail_status != 200 or not isinstance(failed_detail_data, dict):
                    print(
                        "[FAIL] failed-rows-case /api/data-quality/failed failed: "
                        f"status={failed_detail_status}, data={failed_detail_data}"
                    )
                    return 1
                failed_total_rows = int(failed_detail_data.get("total_failed_rows") or 0)
                failed_items = failed_detail_data.get("items") or []
                failed_returned_rows = int(
                    failed_detail_data.get("returned_rows")
                    if failed_detail_data.get("returned_rows") is not None
                    else len(failed_items)
                )
                if failed_total_rows <= 0 or failed_returned_rows <= 0 or len(failed_items) == 0:
                    print(
                        "[FAIL] failed-rows-case expected failed detail rows but got: "
                        f"{json.dumps(failed_detail_data, ensure_ascii=False)}"
                    )
                    return 1

                score_failed_status, score_failed_data = http_json(
                    "POST",
                    f"{base_url}/api/scoring/run",
                    payload=scoring_payload,
                    timeout_sec=args.timeout_sec,
                )
                if score_failed_status != 400:
                    print(
                        "[FAIL] failed-rows-case expected /api/scoring/run status=400 "
                        f"but got {score_failed_status}, data={score_failed_data}"
                    )
                    return 1

                failed_rows_case_summary = {
                    "failed_rows": failed_rows_value,
                    "failed_rules": failed_rules,
                    "failed_total_rows": failed_total_rows,
                    "failed_returned_rows": failed_returned_rows,
                    "failed_scoring_status": score_failed_status,
                }
            finally:
                if original_values:
                    try:
                        set_algo_values(base_url, original_values, timeout_sec=args.timeout_sec)
                    except Exception as e:  # pragma: no cover
                        restore_error = str(e)

            if restore_error:
                print(f"[FAIL] failed-rows-case restore config failed: {restore_error}")
                return 1

            refresh_restore_status, refresh_restore_data = refresh_with_retry(
                base_url=base_url,
                source=args.source,
                timeout_sec=args.timeout_sec,
            )
            if refresh_restore_status != 200:
                print(
                    "[FAIL] failed-rows-case restore refresh failed: "
                    f"status={refresh_restore_status}, data={refresh_restore_data}"
                )
                return 1

            dq_restore2_status, dq_restore2_data = http_json("GET", dq_url, timeout_sec=args.timeout_sec)
            if dq_restore2_status != 200 or not isinstance(dq_restore2_data, dict):
                print(
                    "[FAIL] failed-rows-case restore snapshot failed: "
                    f"status={dq_restore2_status}, data={dq_restore2_data}"
                )
                return 1
            restored2_publish_allowed = bool(dq_restore2_data.get("publish_allowed", False))
            if restored2_publish_allowed != publish_allowed:
                print(
                    "[FAIL] failed-rows-case restore mismatch: "
                    f"expected publish_allowed={publish_allowed}, actual={restored2_publish_allowed}, "
                    f"snapshot={dq_restore2_data}"
                )
                return 1
            failed_rows_case_summary["restored_publish_allowed"] = restored2_publish_allowed

        summary = {
            "health_status": health_status,
            "refresh_status": refresh_status,
            "total_rows": dq_data.get("total_rows"),
            "ok_rows": dq_data.get("ok_rows"),
            "failed_rows": dq_data.get("failed_rows"),
            "publish_allowed": publish_allowed,
            "blocked_rules": len(dq_data.get("publish_blocked_reasons") or []),
            "trend_count": len(trend_items),
            "scoring_status": score_status,
        }
        if blocked_case_summary is not None:
            summary["blocked_case"] = blocked_case_summary
        if failed_rows_case_summary is not None:
            summary["failed_rows_case"] = failed_rows_case_summary
        print("[PASS] quality gate smoke test")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        if out_file is not None:
            out_file.close()
        if err_file is not None:
            err_file.close()


if __name__ == "__main__":
    raise SystemExit(main())

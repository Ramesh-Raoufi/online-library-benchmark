"""Read-only HTTP measurements, deliberately separate from SQL timings."""
import json, time, platform, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime, timezone
out=Path("results"); out.mkdir(exist_ok=True)
url="https://online-library-benchmark.onrender.com"
result={"started_at":datetime.now(timezone.utc).isoformat(),"origin":url,"client":platform.platform(),"method":"Sequential fresh HTTPS GET requests; includes DNS/TLS/network; no login or mutations","samples":[]}
for route in ["/api/health","/"]:
    for i in range(21):
        before=time.perf_counter(); sample={"route":route,"index":i,"warmup":i==0}
        try:
            with urllib.request.urlopen(urllib.request.Request(url+route,headers={"User-Agent":"Library-Monograph-ReadOnly-Test/1.0"}),timeout=90) as response:
                body=response.read(); sample.update(status=response.status,bytes=len(body))
                if route=="/api/health": sample["body"]=body.decode("utf-8")
        except Exception as error: sample["error"]=str(error)
        sample["elapsed_ms"]=(time.perf_counter()-before)*1000; result["samples"].append(sample)
        if "error" in sample: break
result["completed_at"]=datetime.now(timezone.utc).isoformat()
(out/"http-study.json").write_text(json.dumps(result,indent=2))
print(json.dumps({"requests":len(result["samples"]),"errors":sum("error" in s for s in result["samples"])}))

# Loglar ve metrikler: Prometheus, Grafana, Loki

`kubectl logs` ve `kubectl top` anlık sorular için yeterli, ama "dün gece 03:12'de ne oldu?", "p95 gecikme son bir haftada nasıl değişti?", "hangi Pod'lar sürekli bellek sınırına yaklaşıyor?" gibi soruların cevabı için verinin **toplanması, saklanması ve sorgulanması** gerekir. Bu derste Kubernetes'te gözlemlenebilirliğin üç ayağını (metrikler, loglar, izler) ve en yaygın açık kaynak yığını kuracağız.

```lab
Killercoda: Kubernetes playground
https://killercoda.com/playgrounds/scenario/kubernetes
Bu dersteki yığın birkaç GB bellek ister. Lab kümesinde kaynak yetmezse bazı Pod'lar Pending kalabilir. Ders, bileşenleri tek tek ve küçük ayarlarla kurar.
```

## Üç sinyal

| Sinyal | Soru | Araç (açık kaynak) |
|---|---|---|
| **Metrik** | Ne kadar, ne sıklıkla? (sayılar, zaman serisi) | Prometheus, Grafana |
| **Log** | Tam olarak ne oldu? (olay kayıtları) | Loki (ya da Elasticsearch/OpenSearch), Grafana |
| **İz (trace)** | Bir istek hangi servislerden geçti, nerede zaman harcadı? | OpenTelemetry, Tempo/Jaeger |

**OpenTelemetry** üçü için ortak bir standart ve toplayıcı (collector) sunar. Uygulamaları ona göre enstrümante etmek, arka uç değiştirmeyi kolaylaştırır.

## Prometheus modeli

Prometheus **çeker** (pull): Hedeflerin `/metrics` uç noktasını düzenli aralıklarla (örneğin 30 sn) okur. Metrikler metin biçimindedir:

```text
http_requests_total{method="GET", path="/api/siparis", status="200"} 10432
http_request_duration_seconds_bucket{path="/api/siparis", le="0.25"} 9871
container_memory_working_set_bytes{namespace="odeme", pod="api-7c9d..."} 1.82e+08
```

Kubernetes'te metrik kaynakları:

| Kaynak | Ne verir |
|---|---|
| **kubelet / cAdvisor** | Konteyner CPU, bellek, ağ, disk kullanımı |
| **kube-state-metrics** | Nesnelerin **durumu**: Deployment'ın istenen/hazır replika sayısı, Pod'un yeniden başlama sayısı, Job başarısızlıkları, PVC durumu |
| **node-exporter** (DaemonSet) | Node seviyesi: CPU, bellek, disk, ağ, dosya sistemi (Linux kursundaki `/proc` bilgileri) |
| **Uygulamanın kendisi** | İş metrikleri: istek sayısı, gecikme, hata oranı, kuyruk uzunluğu |
| Kontrol düzlemi | apiserver, etcd, scheduler metrikleri |

## kube-prometheus-stack

Bütün bunları bir arada kuran yaygın Helm chart'ı **kube-prometheus-stack**: Prometheus Operator, Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics ve hazır panolar ile alarm kuralları.

```bash
command -v helm >/dev/null || curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
cat > izleme-degerler.yaml <<'YAML'
alertmanager:
  alertmanagerSpec:
    resources: { requests: { cpu: 10m, memory: 32Mi } }
prometheus:
  prometheusSpec:
    retention: 2d
    resources: { requests: { cpu: 100m, memory: 400Mi } }
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
grafana:
  adminPassword: lab-parolasi
  service:
    type: NodePort
    nodePort: 30300
YAML
helm install izleme prometheus-community/kube-prometheus-stack -n izleme --create-namespace -f izleme-degerler.yaml --wait --timeout 10m
kubectl -n izleme get pods
```

(Killercoda'nın port açma menüsünden 30300'ü açarak Grafana'ya `admin` / `lab-parolasi` ile girebilirsin. "Dashboards" altında node'lar, namespace'ler, Pod'lar için hazır panolar var.)

### PromQL

Prometheus'un sorgu dili. Arayüzü port-forward ile açıp ya da API'yi doğrudan sorgulayarak deneyelim:

```bash
kubectl -n izleme port-forward svc/izleme-kube-prometheus-sta-prometheus 9090 >/dev/null 2>&1 &
sleep 3
sorgu() { curl -s "localhost:9090/api/v1/query" --data-urlencode "query=$1" | python3 -c 'import sys,json; [print(r["metric"], r["value"][1]) for r in json.load(sys.stdin)["data"]["result"][:8]]'; }
sorgu 'up'
sorgu 'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))'
sorgu 'topk(5, sum by (pod) (container_memory_working_set_bytes{container!=""}))'
sorgu 'kube_deployment_status_replicas_available != kube_deployment_spec_replicas'
sorgu 'increase(kube_pod_container_status_restarts_total[1h]) > 0'
```

(Service adı chart sürümüne göre farklı olabilir: `kubectl -n izleme get svc | grep prometheus`.)

| Sorgu parçası | Anlamı |
|---|---|
| `rate(x[5m])` | Sayaçların (counter) son 5 dakikadaki saniye başına artış hızı. Sayaçlar her zaman `rate`/`increase` ile kullanılır |
| `sum by (namespace) (...)` | Etikete göre grupla |
| `topk(5, ...)` | En büyük 5 |
| `histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))` | p95 (Linux kursundaki persentil hesabının Prometheus karşılığı) |
| `kube_..._status != kube_..._spec` | Gözlenen ≠ istenen: kube-state-metrics ile "uzlaşmamış" nesneler |

### Kendi uygulamanı izlemek: ServiceMonitor

Prometheus Operator, hangi uygulamaların kazınacağını **ServiceMonitor** nesneleriyle öğrenir. podinfo, `/metrics` uç noktası olan bir uygulama:

```bash
helm repo add podinfo https://stefanprodan.github.io/podinfo
helm upgrade --install demo podinfo/podinfo -n demo --create-namespace --set serviceMonitor.enabled=true --wait
kubectl -n demo get servicemonitor
sleep 60
sorgu 'sum by (path, status) (rate(http_requests_total{namespace="demo"}[2m]))'
```

```yaml
# podinfo chart'ının ürettiği ServiceMonitor'ın özü:
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
spec:
  selector:
    matchLabels: { app.kubernetes.io/name: demo-podinfo }
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
```

Kendi uygulamalarına metrik eklemek için dilinin Prometheus istemci kütüphanesi (Python `prometheus_client`, Go `client_golang`, Node `prom-client`) ya da OpenTelemetry kullanılır. Başlangıç için en değerli metrikler **RED** yöntemi: **R**ate (istek hızı), **E**rrors (hata oranı), **D**uration (gecikme dağılımı). Altyapı kaynakları için Linux kursundaki **USE** yöntemi.

> **Kardinalite:** Her benzersiz etiket kombinasyonu ayrı bir zaman serisidir. Etiketlere kullanıcı kimliği, sipariş numarası ya da tam URL koymak milyonlarca seri üretir ve Prometheus'u çökertir. Etiket değerleri sınırlı bir küme olmalı (`path="/api/siparis/:id"`, `/api/siparis/42` değil).

## Alarmlar

Panolar bakan birine bilgi verir. Alarmlar ise kimse bakmıyorken haber verir. **PrometheusRule** ile kural, **Alertmanager** ile yönlendirme (Slack, e-posta, PagerDuty, gruplama, susturma):

```bash
cat > alarm.yaml <<'YAML'
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: uygulama-alarmlari
  namespace: izleme
spec:
  groups:
    - name: uygulama
      rules:
        - alert: PodSurekliYenidenBasliyor
          expr: increase(kube_pod_container_status_restarts_total[15m]) > 3
          for: 5m
          labels: { severity: warning }
          annotations:
            summary: "{{ $labels.namespace }}/{{ $labels.pod }} 15 dakikada 3'ten fazla yeniden başladı"
        - alert: YuksekHataOrani
          expr: |
            sum by (namespace) (rate(http_requests_total{status=~"5.."}[5m]))
              / sum by (namespace) (rate(http_requests_total[5m])) > 0.05
          for: 10m
          labels: { severity: critical }
          annotations:
            summary: "{{ $labels.namespace }} 5xx oranı %5'in üstünde"
YAML
kubectl apply -f alarm.yaml
sleep 30
curl -s localhost:9090/api/v1/rules | python3 -c 'import sys,json; [print(r["name"], r["state"]) for g in json.load(sys.stdin)["data"]["groups"] if g["name"]=="uygulama" for r in g["rules"]]'
```

İyi alarm kuralları:

- **Belirtiye göre alarm ver, sebebe göre değil**: "Kullanıcılar hata alıyor" (yüksek 5xx, yüksek gecikme, SLO bütçesi tükeniyor) her zaman alarm. "CPU %80" çoğu zaman alarm değil, panoda bir bilgi.
- `for:` ile kısa sıçramaları ele.
- Her alarmın bir **eylemi** olsun: Uyandırılan kişinin ne yapacağını anlatan bir runbook bağlantısı.
- kube-prometheus-stack'in hazır kuralları (KubePodCrashLooping, KubeNodeNotReady, KubePersistentVolumeFillingUp, etcd ve apiserver alarmları) iyi bir başlangıç.

## Loglar: Loki

Konteyner logları node'larda `/var/log/pods/` altındaki dosyalardadır ve Pod silinince ya da döndürülünce kaybolur. Merkezi loglama için her node'da bir ajan (DaemonSet) bu dosyaları okuyup bir arka uca gönderir:

```text
Pod stdout/stderr ──▶ node'daki /var/log/pods/... ──▶ ajan (Grafana Alloy, Fluent Bit, Vector) ──▶ Loki ──▶ Grafana
```

**Loki**, logların içeriğini değil sadece **etiketlerini** (namespace, pod, container, app) indeksler: Elasticsearch'e göre çok daha ucuzdur. Sorgu dili **LogQL**, PromQL'e benzer:

```text
{namespace="odeme", app="api"} |= "ERROR"
{namespace="odeme"} | json | level="error" | line_format "{{.msg}}"
sum by (pod) (count_over_time({namespace="odeme"} |= "timeout" [5m]))
```

Son sorgu loglardan metrik üretir: Linux kursundaki `grep | wc -l` kalıbının küme genelindeki karşılığı. Docker kursundaki öneriler burada da geçerli: Uygulamalar stdout'a, tercihen **JSON** yazsın. Yapılandırılmış loglar alan bazlı filtreleme sağlar.

Lab kümesinin belleği tam yığına yetmeyebilir. Kurulum, Grafana'nın Helm chart'larıyla (`grafana/loki` tek ikili modu ve `grafana/alloy` ya da `fluent-bit`) yapılır ve Grafana'ya Loki veri kaynağı eklenir.

## İzler

Bir istek nginx → API → ödeme servisi → veritabanı zincirinden geçerken gecikmenin nerede olduğunu metrikler ve loglar tek başına söyleyemez. **Dağıtık izleme** her isteğe bir iz kimliği verir ve her servisin harcadığı süreyi (span) kaydeder. Uygulamalar **OpenTelemetry** SDK'larıyla (çoğu dil ve çerçeve için otomatik enstrümantasyon var) izleri bir **OpenTelemetry Collector**'a gönderir, oradan Tempo ya da Jaeger'a. Log satırlarına iz kimliğini eklemek, bir hatanın logundan ilgili ize tek tıkla geçmeyi sağlar.

## Temizlik

```bash
kill %1 2>/dev/null
helm uninstall demo -n demo; helm uninstall izleme -n izleme
kubectl delete ns demo izleme
kubectl get crd | grep monitoring.coreos.com | awk '{print $1}' | xargs -r kubectl delete crd
```

(Helm, Prometheus Operator'ın CRD'lerini silmez, Helm dersinde gördüğümüz gibi. Son satır onları temizler.)

## Alıştırma (lab'da)

1. kube-prometheus-stack kuruluyken, son 1 saatte en çok yeniden başlayan 5 konteyneri bulan bir PromQL sorgusu yaz.
2. Her namespace'in CPU **requests** toplamı ile gerçek CPU kullanımını karşılaştıran bir sorgu yaz. Hangi namespace'ler requests'ini büyük ölçüde kullanmıyor? (Kaynak dersindeki "requests'i ölçerek ver" önerisinin verisi.)

<details><summary>Çözüm</summary>

```bash
sorgu 'topk(5, increase(kube_pod_container_status_restarts_total[1h]))'
sorgu 'sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})'
sorgu 'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!=""}[5m])) / sum by (namespace) (kube_pod_container_resource_requests{resource="cpu"})'
```

Son sorgu, kullanım/requests oranını verir. 0.1 gibi düşük değerler, requests'in gerçek ihtiyacın çok üstünde olduğunu ve kümede boşa ayrılmış kapasite olduğunu gösterir. 1'in üstündeki değerler requests'in az verildiğini (Burstable Pod'lar, sıkışmada ilk tahliye edilenler) gösterir.

</details>

```quiz
Bir Deployment'ın hazır replika sayısının istenen sayıdan az olduğunu Prometheus hangi kaynaktan öğrenir?
- cAdvisor
- node-exporter
- [x] kube-state-metrics
? kube-state-metrics, Kubernetes nesnelerinin spec ve status alanlarını metrik olarak sunar.
```

```quiz
Prometheus'ta `http_requests_total` sayacını grafikte nasıl kullanırsın?
- Doğrudan değeriyle
- [x] `rate(http_requests_total[5m])` ile saniye başına hız olarak
- `max()` ile
? Sayaçlar sürekli artar ve yeniden başlatmada sıfırlanır. rate/increase bunları doğru yorumlar.
```

```quiz
Prometheus belleği hızla doldu. Yeni eklenen bir metrikte `user_id` etiketi var. Sorun nedir?
- Scrape aralığı kısa
- [x] Yüksek kardinalite: her kullanıcı için ayrı bir zaman serisi oluşuyor
- Retention süresi uzun
? Etiket değerleri sınırlı bir küme olmalı. Kullanıcı ve sipariş kimlikleri log ya da izlerde tutulur.
```

## Özet

- Üç sinyal: metrik (Prometheus), log (Loki), iz (OpenTelemetry + Tempo/Jaeger). Grafana hepsini birleştirir.
- Metrik kaynakları: cAdvisor (kullanım), kube-state-metrics (nesne durumu), node-exporter (node), uygulama `/metrics`.
- kube-prometheus-stack: Operator, ServiceMonitor, PrometheusRule, Alertmanager, hazır panolar.
- PromQL: `rate`, `sum by`, `topk`, `histogram_quantile`. Kardinaliteye dikkat.
- Belirtiye göre alarm, `for:` ile kararlılık, runbook. RED (servisler), USE (kaynaklar).
- Loglar: DaemonSet ajanı → Loki, LogQL. Uygulamalar JSON ile stdout'a yazar.

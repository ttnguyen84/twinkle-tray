#define WIN32_LEAN_AND_MEAN
#include <napi.h>
#include <windows.h>
#include <sensorsapi.h>
#include <sensors.h>
#include <propvarutil.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <wchar.h>
#include <memory>
#include <string>
#include <vector>
#include "utils.hpp"

#pragma comment(lib, "sensorsapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "propsys.lib")

// ---------- Minimal ISensorEvents implementation ----------
// The Windows Sensor API requires an event sink to be registered on each
// ISensor so the driver knows a client is consuming data. Without this
// subscription the driver never pushes fresh reports and GetData() keeps
// returning the same stale value.
class LightSensorEvents : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    ISensorEvents>
{
public:
    STDMETHODIMP OnStateChanged(ISensor*, SensorState) override { return S_OK; }
    STDMETHODIMP OnDataUpdated(ISensor*, ISensorDataReport*) override { return S_OK; }
    STDMETHODIMP OnEvent(ISensor*, REFGUID, IPortableDeviceValues*) override { return S_OK; }
    STDMETHODIMP OnLeave(REFSENSOR_ID) override { return S_OK; }
};

// ---------- Cached sensor state ----------
struct CachedSensor {
    ComPtr<ISensor> sensor;
    ComPtr<ISensorEvents> events;

    CachedSensor() = default;
    CachedSensor(CachedSensor&&) noexcept = default;
    CachedSensor& operator=(CachedSensor&&) noexcept = default;
    CachedSensor(const CachedSensor&) = delete;
    CachedSensor& operator=(const CachedSensor&) = delete;

    ~CachedSensor() {
        if (sensor) {
            sensor->SetEventSink(nullptr);
        }
    }
};

std::vector<CachedSensor> cachedLightSensors;
std::unique_ptr<ComInit> sensorComLifetime;

// ---------- Helpers ----------

// Set the report interval so the sensor driver delivers fresh data at
// roughly the requested cadence (milliseconds).
static void SetReportInterval(ISensor* sensor, ULONG intervalMs = 200) {
    if (!sensor) return;

    ComPtr<IPortableDeviceValues> props;
    if (FAILED(CoCreateInstance(
            CLSID_PortableDeviceValues, nullptr,
            CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&props))))
        return;

    PROPVARIANT pv;
    InitPropVariantFromUInt32(intervalMs, &pv);
    props->SetValue(SENSOR_PROPERTY_CURRENT_REPORT_INTERVAL, &pv);
    PropVariantClear(&pv);

    sensor->SetProperties(props.Get(), nullptr);
}

double ReadLux(const ComPtr<ISensor>& sensor) {
    if (!sensor) return -1;

    ComPtr<ISensorDataReport> report;
    if (FAILED(sensor->GetData(&report)) || !report) return -1;

    PROPVARIANT value;
    PropVariantInit(&value);
    const HRESULT result = report->GetSensorValue(SENSOR_DATA_TYPE_LIGHT_LEVEL_LUX, &value);
    double lux = -1;
    if (SUCCEEDED(result)) {
        if (value.vt == VT_R4) lux = value.fltVal;
        else if (value.vt == VT_R8) lux = value.dblVal;
        else if (value.vt == VT_UI4) lux = value.ulVal;
        else if (value.vt == VT_I4) lux = value.lVal;
    }
    PropVariantClear(&value);
    return lux;
}

void ClearCachedSensors() {
    cachedLightSensors.clear();
}

void RefreshCachedLightSensors() {
    ClearCachedSensors();
    auto rawSensors = GetSensors();

    cachedLightSensors.reserve(rawSensors.size());
    for (auto& sensor : rawSensors) {
        if (!sensor) continue;
        CachedSensor entry;
        entry.sensor = sensor;

        // Subscribe to events so the driver pushes fresh data reports.
        auto events = Microsoft::WRL::Make<LightSensorEvents>();
        if (events && SUCCEEDED(sensor->SetEventSink(events.Get()))) {
            entry.events = events;
        }

        // Ask the driver for ~200 ms report intervals.
        SetReportInterval(sensor.Get(), 200);

        cachedLightSensors.push_back(std::move(entry));
    }
}

std::vector<SensorInfo> GetAllLightSensors() {
    ComInit com;
    RefreshCachedLightSensors();

    std::vector<SensorInfo> sensorInfos;
    sensorInfos.reserve(cachedLightSensors.size());
    for (const auto& entry : cachedLightSensors) {
        sensorInfos.emplace_back(entry.sensor);
    }
    return sensorInfos;
}

double GetLuxValueById(const std::string& id) {
    ComInit com;
    if (cachedLightSensors.empty()) RefreshCachedLightSensors();
    for (const auto& entry : cachedLightSensors) {
        SENSOR_ID sensorId;
        if (SUCCEEDED(entry.sensor->GetID(&sensorId))) {
            if (GuidToString(sensorId) == id) {
                return ReadLux(entry.sensor);
            }
        }
    }
    return -1;
}

// Node.js wrapper for getAmbientLightSensors
Napi::Array NodeGetAmbientLightSensors(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);

    try {
        std::vector<SensorInfo> sensors = GetAllLightSensors();
        
        for (size_t i = 0; i < sensors.size(); i++) {
            Napi::Object sensorObj = Napi::Object::New(env);
            sensorObj.Set("id", Napi::String::New(env, sensors[i].id));
            sensorObj.Set("name", Napi::String::New(env, sensors[i].name));
            sensorObj.Set("state", Napi::String::New(env, sensors[i].state));

            if (sensors[i].currentLux >= 0.0) {
                sensorObj.Set("currentLux", Napi::Number::New(env, sensors[i].currentLux));
            } else {
                sensorObj.Set("currentLux", env.Null());
            }

            result.Set((uint32_t)i, sensorObj);
        }
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    } catch (...) {
        Napi::Error::New(env, "Unknown error occurred").ThrowAsJavaScriptException();
    }

    return result;
}

// Node.js wrapper for getLuxValue
Napi::Value NodeGetLuxValue(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    try {
        std::string sensorId;
        bool hasId = false;

        // Check if sensor ID was provided
        if (info.Length() > 0 && info[0].IsString()) {
            sensorId = info[0].As<Napi::String>().Utf8Value();
            hasId = true;
        }

        double luxValue = -1.0;

        if (hasId) {
            // Get lux from specific sensor
            luxValue = GetLuxValueById(sensorId);
        } else {
            // Get lux from first available sensor
            if (cachedLightSensors.empty()) RefreshCachedLightSensors();
            for (const auto& entry : cachedLightSensors) {
                luxValue = ReadLux(entry.sensor);
                if (luxValue >= 0.0) {
                    break;
                }
            }
        }

        if (luxValue >= 0.0) {
            return Napi::Number::New(env, luxValue);
        } else {
            return env.Null();
        }
    } catch (const std::exception& e) {
        Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        return env.Null();
    } catch (...) {
        Napi::Error::New(env, "Unknown error occurred").ThrowAsJavaScriptException();
        return env.Null();
    }
}

// Initialize the module
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    sensorComLifetime = std::make_unique<ComInit>();
    exports.Set(Napi::String::New(env, "getAmbientLightSensors"), 
                Napi::Function::New(env, NodeGetAmbientLightSensors));
    exports.Set(Napi::String::New(env, "getLuxValue"), 
                Napi::Function::New(env, NodeGetLuxValue));
    return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)

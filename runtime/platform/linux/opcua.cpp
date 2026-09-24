#include "opcua.h"

#include <open62541.h>
#include <stdio.h>
#include <string.h>

#include <map>

#include "isa.h"

namespace vplc {

namespace {

OpcUaServer* g_server = nullptr;  // a single OPC UA server per process

const UA_DataType* uaType(const SymbolInfo& s) {
    if (s.bit != 0xFF) return &UA_TYPES[UA_TYPES_BOOLEAN];
    switch (s.type) {
        case uint8_t(VmType::T_BOOL): return &UA_TYPES[UA_TYPES_BOOLEAN];
        case uint8_t(VmType::T_U8): return &UA_TYPES[UA_TYPES_BYTE];
        case uint8_t(VmType::T_I8): return &UA_TYPES[UA_TYPES_SBYTE];
        case uint8_t(VmType::T_U16): return &UA_TYPES[UA_TYPES_UINT16];
        case uint8_t(VmType::T_I16): return &UA_TYPES[UA_TYPES_INT16];
        case uint8_t(VmType::T_U32): return &UA_TYPES[UA_TYPES_UINT32];
        case uint8_t(VmType::T_I32): return &UA_TYPES[UA_TYPES_INT32];
        case uint8_t(VmType::T_I64): return &UA_TYPES[UA_TYPES_INT64];
        case uint8_t(VmType::T_U64): return &UA_TYPES[UA_TYPES_UINT64];
        case uint8_t(VmType::T_F32): return &UA_TYPES[UA_TYPES_FLOAT];
        case uint8_t(VmType::T_F64): return &UA_TYPES[UA_TYPES_DOUBLE];
        case HMI_TIME: return &UA_TYPES[UA_TYPES_INT32];  // milliseconds
        case HMI_STRING: return &UA_TYPES[UA_TYPES_STRING];
        default: return nullptr;
    }
}

UA_StatusCode readVariable(UA_Server*, const UA_NodeId*, void*, const UA_NodeId*, void* nodeContext, UA_Boolean,
                           const UA_NumericRange*, UA_DataValue* value) {
    if (!g_server) return UA_STATUSCODE_BADINTERNALERROR;
    const SymbolInfo* s = g_server->symbol(uint32_t(reinterpret_cast<uintptr_t>(nodeContext)));
    HmiValue v;
    if (!s || !hmiRead(g_server->cpu().vm(), *s, v)) return UA_STATUSCODE_BADNOTREADABLE;
    const UA_DataType* t = uaType(*s);
    UA_StatusCode rc = UA_STATUSCODE_GOOD;
    switch (t->typeKind) {
        case UA_DATATYPEKIND_BOOLEAN: { UA_Boolean x = v.b; rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_BYTE: { UA_Byte x = UA_Byte(v.u); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_SBYTE: { UA_SByte x = UA_SByte(v.i); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_UINT16: { UA_UInt16 x = UA_UInt16(v.u); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_INT16: { UA_Int16 x = UA_Int16(v.i); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_UINT32: { UA_UInt32 x = UA_UInt32(v.u); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_INT32: { UA_Int32 x = UA_Int32(v.i); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_INT64: { UA_Int64 x = v.i; rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_UINT64: { UA_UInt64 x = v.u; rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_FLOAT: { UA_Float x = UA_Float(v.f); rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_DOUBLE: { UA_Double x = v.f; rc = UA_Variant_setScalarCopy(&value->value, &x, t); break; }
        case UA_DATATYPEKIND_STRING: {
            UA_String x;
            x.length = v.length;
            x.data = reinterpret_cast<UA_Byte*>(v.s);
            rc = UA_Variant_setScalarCopy(&value->value, &x, t);
            break;
        }
        default: return UA_STATUSCODE_BADNOTREADABLE;
    }
    if (rc != UA_STATUSCODE_GOOD) return rc;
    value->hasValue = true;
    return UA_STATUSCODE_GOOD;
}

UA_StatusCode writeVariable(UA_Server*, const UA_NodeId*, void*, const UA_NodeId*, void* nodeContext, const UA_NumericRange* range,
                            const UA_DataValue* data) {
    if (!g_server) return UA_STATUSCODE_BADINTERNALERROR;
    if (range) return UA_STATUSCODE_BADINDEXRANGEINVALID;
    const SymbolInfo* s = g_server->symbol(uint32_t(reinterpret_cast<uintptr_t>(nodeContext)));
    if (!s || !s->writable || !g_server->allowWrite()) return UA_STATUSCODE_BADNOTWRITABLE;
    if (!data->hasValue || !UA_Variant_isScalar(&data->value)) return UA_STATUSCODE_BADTYPEMISMATCH;
    const UA_Variant& var = data->value;
    HmiValue v;
    switch (var.type->typeKind) {
        case UA_DATATYPEKIND_BOOLEAN: v.kind = HmiValue::BOOL; v.b = *static_cast<UA_Boolean*>(var.data); break;
        case UA_DATATYPEKIND_SBYTE: v.kind = HmiValue::INT; v.i = *static_cast<UA_SByte*>(var.data); break;
        case UA_DATATYPEKIND_BYTE: v.kind = HmiValue::UINT; v.u = *static_cast<UA_Byte*>(var.data); break;
        case UA_DATATYPEKIND_INT16: v.kind = HmiValue::INT; v.i = *static_cast<UA_Int16*>(var.data); break;
        case UA_DATATYPEKIND_UINT16: v.kind = HmiValue::UINT; v.u = *static_cast<UA_UInt16*>(var.data); break;
        case UA_DATATYPEKIND_INT32: v.kind = HmiValue::INT; v.i = *static_cast<UA_Int32*>(var.data); break;
        case UA_DATATYPEKIND_UINT32: v.kind = HmiValue::UINT; v.u = *static_cast<UA_UInt32*>(var.data); break;
        case UA_DATATYPEKIND_INT64: v.kind = HmiValue::INT; v.i = *static_cast<UA_Int64*>(var.data); break;
        case UA_DATATYPEKIND_UINT64: v.kind = HmiValue::UINT; v.u = *static_cast<UA_UInt64*>(var.data); break;
        case UA_DATATYPEKIND_FLOAT: v.kind = HmiValue::REAL; v.f = *static_cast<UA_Float*>(var.data); break;
        case UA_DATATYPEKIND_DOUBLE: v.kind = HmiValue::REAL; v.f = *static_cast<UA_Double*>(var.data); break;
        case UA_DATATYPEKIND_STRING: {
            const UA_String* str = static_cast<UA_String*>(var.data);
            v.kind = HmiValue::STRING;
            v.length = uint8_t(str->length < 254 ? str->length : 254);
            memcpy(v.s, str->data, v.length);
            break;
        }
        default: return UA_STATUSCODE_BADTYPEMISMATCH;
    }
    const char* err = hmiWrite(g_server->cpu().vm(), *s, v);
    if (!err) return UA_STATUSCODE_GOOD;
    if (!strcmp(err, "out of range")) return UA_STATUSCODE_BADOUTOFRANGE;
    if (!strcmp(err, "type mismatch")) return UA_STATUSCODE_BADTYPEMISMATCH;
    if (!strcmp(err, "read-only")) return UA_STATUSCODE_BADNOTWRITABLE;
    return UA_STATUSCODE_BADINTERNALERROR;
}

// CPU status variables (read only)
enum StatusVar : uintptr_t { ST_STATE = 1, ST_PROGRAM, ST_SCAN };

UA_StatusCode readStatus(UA_Server*, const UA_NodeId*, void*, const UA_NodeId*, void* nodeContext, UA_Boolean,
                         const UA_NumericRange*, UA_DataValue* value) {
    if (!g_server) return UA_STATUSCODE_BADINTERNALERROR;
    Cpu& cpu = g_server->cpu();
    UA_String s;
    switch (reinterpret_cast<uintptr_t>(nodeContext)) {
        case ST_STATE: s = UA_STRING(const_cast<char*>(stateName(cpu.state()))); break;
        case ST_PROGRAM: s = UA_STRING(const_cast<char*>(cpu.program().name)); break;
        default: return UA_STATUSCODE_BADNOTREADABLE;
    }
    UA_Variant_setScalarCopy(&value->value, &s, &UA_TYPES[UA_TYPES_STRING]);
    value->hasValue = true;
    return UA_STATUSCODE_GOOD;
}

UA_NodeId stringId(UA_UInt16 ns, const std::string& id) {
    return UA_NODEID_STRING_ALLOC(ns, id.c_str());
}

}  // namespace

OpcUaServer::OpcUaServer(Cpu& cpu, Platform& platform) : cpu_(cpu), platform_(platform) { g_server = this; }

OpcUaServer::~OpcUaServer() {
    stop();
    g_server = nullptr;
}

void OpcUaServer::setUser(const std::string& user, const std::string& password) {
    user_ = user;
    password_ = password;
}

void OpcUaServer::configure(uint16_t port, bool allowWrite, bool anonymous, const std::string& name) {
    uint32_t id = port ? cpu_.program().id : 0;
    bool same = port == port_ && allowWrite == write_ && anonymous == anonymous_ && name == name_ && id == programId_;
    if (same && (server_ || !port)) return;
    if (same && platform_.millis() < retryAt_) return;  // a failed start is retried every 5 s
    stop();
    port_ = port;
    write_ = allowWrite;
    anonymous_ = anonymous;
    name_ = name;
    programId_ = id;
    if (port) start();
}

void OpcUaServer::start() {
    UA_Server* server = UA_Server_new();
    UA_ServerConfig* config = UA_Server_getConfig(server);
    config->logging = UA_Log_Stdout_new(UA_LOGLEVEL_WARNING);
    if (UA_ServerConfig_setMinimal(config, port_, nullptr) != UA_STATUSCODE_GOOD) {
        UA_Server_delete(server);
        platform_.log("OPC UA: configuration failed");
        retryAt_ = platform_.millis() + 5000;
        return;
    }
    std::string app = "VirtualPLC " + name_;
    UA_LocalizedText_clear(&config->applicationDescription.applicationName);
    config->applicationDescription.applicationName = UA_LOCALIZEDTEXT_ALLOC("", app.c_str());
    UA_String_clear(&config->applicationDescription.applicationUri);
    config->applicationDescription.applicationUri = UA_STRING_ALLOC(("urn:virtualplc:" + name_).c_str());
    for (size_t i = 0; i < config->endpointsSize; i++) {
        UA_String_clear(&config->endpoints[i].server.applicationUri);
        UA_String_copy(&config->applicationDescription.applicationUri, &config->endpoints[i].server.applicationUri);
    }

    // Access: anonymous and/or user name + password (security policy None: use a trusted network or a VPN)
    config->accessControl.clear(&config->accessControl);
    UA_UsernamePasswordLogin login;
    login.username = UA_STRING(const_cast<char*>(user_.c_str()));
    login.password = UA_STRING(const_cast<char*>(password_.c_str()));
    bool withUser = !user_.empty() && !password_.empty();
    UA_AccessControl_default(config, anonymous_ || !withUser, nullptr, withUser ? 1 : 0, withUser ? &login : nullptr);
    config->allowNonePolicyPassword = withUser;

    server_ = server;
    build();
    if (UA_Server_run_startup(server_) != UA_STATUSCODE_GOOD) {
        char msg[96];
        snprintf(msg, sizeof msg, "OPC UA: cannot open port %u", unsigned(port_));
        platform_.log(msg);
        UA_Server_delete(server_);
        server_ = nullptr;
        retryAt_ = platform_.millis() + 5000;
        return;
    }
    char msg[160];
    snprintf(msg, sizeof msg, "OPC UA server on opc.tcp://0.0.0.0:%u (%u variables, %s%s)", unsigned(port_), unsigned(symbols_.size()),
             write_ ? "read/write" : "read only", anonymous_ || !withUser ? ", anonymous access" : ", user name required");
    platform_.log(msg);
}

void OpcUaServer::stop() {
    if (!server_) return;
    UA_Server_run_shutdown(server_);
    UA_Server_delete(server_);
    server_ = nullptr;
    symbols_.clear();
    platform_.log("OPC UA server stopped");
}

void OpcUaServer::iterate() {
    if (server_) UA_Server_run_iterate(server_, false);
}

void OpcUaServer::build() {
    UA_UInt16 ns = UA_Server_addNamespace(server_, ("urn:virtualplc:" + name_).c_str());
    const UA_NodeId objects = UA_NODEID_NUMERIC(0, UA_NS0ID_OBJECTSFOLDER);
    const UA_NodeId organizes = UA_NODEID_NUMERIC(0, UA_NS0ID_ORGANIZES);
    const UA_NodeId component = UA_NODEID_NUMERIC(0, UA_NS0ID_HASCOMPONENT);

    auto folder = [&](const std::string& id, const std::string& name, const UA_NodeId& parent, bool top) {
        UA_ObjectAttributes attr = UA_ObjectAttributes_default;
        attr.displayName = UA_LOCALIZEDTEXT(const_cast<char*>(""), const_cast<char*>(name.c_str()));
        UA_NodeId nid = stringId(ns, id);
        UA_Server_addObjectNode(server_, nid, parent, top ? organizes : organizes, UA_QUALIFIEDNAME(ns, const_cast<char*>(name.c_str())),
                                UA_NODEID_NUMERIC(0, UA_NS0ID_FOLDERTYPE), attr, nullptr, nullptr);
        return nid;
    };

    UA_NodeId root = folder(name_, name_, objects, true);

    // CPU status
    UA_NodeId status = folder(name_ + ".CPU", "CPU", root, false);
    struct { const char* name; uintptr_t var; } vars[] = {{"State", ST_STATE}, {"Program", ST_PROGRAM}};
    for (auto& v : vars) {
        UA_VariableAttributes attr = UA_VariableAttributes_default;
        attr.displayName = UA_LOCALIZEDTEXT(const_cast<char*>(""), const_cast<char*>(v.name));
        attr.dataType = UA_TYPES[UA_TYPES_STRING].typeId;
        attr.accessLevel = UA_ACCESSLEVELMASK_READ;
        UA_DataSource ds{readStatus, nullptr};
        UA_NodeId nid = stringId(ns, name_ + ".CPU." + v.name);
        UA_Server_addDataSourceVariableNode(server_, nid, status, component, UA_QUALIFIEDNAME(ns, const_cast<char*>(v.name)),
                                            UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE), attr, ds, reinterpret_cast<void*>(v.var), nullptr);
        UA_NodeId_clear(&nid);
    }
    UA_NodeId_clear(&status);

    // PLC variables: one folder per structure level (tag tables, DBs, structures)
    symbols_.clear();
    SymbolReader reader(cpu_.program().syms);
    SymbolInfo s;
    while (reader.next(s)) symbols_.push_back(s);
    std::map<std::string, UA_NodeId> folders;
    char seg[256];
    for (const SymbolInfo& sym : symbols_) {
        const UA_DataType* type = uaType(sym);
        if (!type) continue;
        std::string path;
        UA_NodeId parent = root;
        for (uint8_t i = 0; i + 1 < sym.segments; i++) {
            const char* t;
            uint8_t len;
            sym.segment(i, t, len);
            std::string name(t, len);
            path += (i ? "." : "") + name;
            auto it = folders.find(path);
            if (it == folders.end()) it = folders.emplace(path, folder(path, name, parent, false)).first;
            parent = it->second;
        }
        const char* t;
        uint8_t len;
        sym.segment(uint8_t(sym.segments - 1), t, len);
        std::string name(t, len);
        sym.fullPath(seg, sizeof seg);
        UA_VariableAttributes attr = UA_VariableAttributes_default;
        attr.displayName = UA_LOCALIZEDTEXT(const_cast<char*>(""), const_cast<char*>(name.c_str()));
        attr.dataType = type->typeId;
        attr.valueRank = UA_VALUERANK_SCALAR;
        attr.accessLevel = UA_ACCESSLEVELMASK_READ | (sym.writable && write_ ? UA_ACCESSLEVELMASK_WRITE : 0);
        attr.userAccessLevel = attr.accessLevel;
        attr.minimumSamplingInterval = double(cpu_.program().cycleMs);
        UA_DataSource ds{readVariable, writeVariable};
        UA_NodeId nid = stringId(ns, seg);
        UA_Server_addDataSourceVariableNode(server_, nid, parent, component, UA_QUALIFIEDNAME(ns, const_cast<char*>(name.c_str())),
                                            UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE), attr, ds,
                                            reinterpret_cast<void*>(uintptr_t(sym.index)), nullptr);
        UA_NodeId_clear(&nid);
    }
    for (auto& f : folders) UA_NodeId_clear(&f.second);
    UA_NodeId_clear(&root);
}

}  // namespace vplc

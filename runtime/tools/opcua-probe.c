/* OPC UA test client for the end-to-end tests of the CPU.
 *
 *   vplc-opcua-probe URL [-u USER -p PASSWORD] COMMAND...
 *     browse                 list the variables of the PLC (node id, access, type)
 *     read NODEID            print the value
 *     write NODEID TYPE VAL  TYPE: bool int16 int32 float double string
 *     subscribe NODEID N     print the first N values notified (100 ms sampling)
 */
#include <open62541.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void quietLog(void* ctx, UA_LogLevel level, UA_LogCategory category, const char* msg, va_list args) {
    (void)ctx; (void)level; (void)category; (void)msg; (void)args;
}
static UA_Logger quiet = {quietLog, NULL, NULL};

static void printValue(const UA_Variant* v) {
    UA_String out = UA_STRING_NULL;
    if (!v->type) { printf("null\n"); return; }
    UA_print(v->data, v->type, &out);
    printf("%.*s\n", (int)out.length, (const char*)out.data);
    UA_String_clear(&out);
}

static void browse(UA_Client* client, UA_NodeId node, int depth) {
    if (depth > 12) return;
    UA_BrowseRequest req;
    UA_BrowseRequest_init(&req);
    req.requestedMaxReferencesPerNode = 0;
    req.nodesToBrowse = UA_BrowseDescription_new();
    req.nodesToBrowseSize = 1;
    UA_NodeId_copy(&node, &req.nodesToBrowse[0].nodeId);
    req.nodesToBrowse[0].resultMask = UA_BROWSERESULTMASK_ALL;
    req.nodesToBrowse[0].browseDirection = UA_BROWSEDIRECTION_FORWARD;
    req.nodesToBrowse[0].referenceTypeId = UA_NODEID_NUMERIC(0, UA_NS0ID_HIERARCHICALREFERENCES);
    req.nodesToBrowse[0].includeSubtypes = true;
    UA_BrowseResponse resp = UA_Client_Service_browse(client, req);
    for (size_t i = 0; i < resp.resultsSize; i++) {
        for (size_t j = 0; j < resp.results[i].referencesSize; j++) {
            UA_ReferenceDescription* ref = &resp.results[i].references[j];
            if (ref->nodeId.nodeId.namespaceIndex == 0) continue;
            UA_String id = UA_STRING_NULL;
            UA_NodeId_print(&ref->nodeId.nodeId, &id);
            if (ref->nodeClass == UA_NODECLASS_VARIABLE) {
                UA_Byte access = 0;
                UA_Client_readAccessLevelAttribute(client, ref->nodeId.nodeId, &access);
                UA_NodeId type;
                UA_Client_readDataTypeAttribute(client, ref->nodeId.nodeId, &type);
                const UA_DataType* dt = UA_findDataType(&type);
                printf("var\t%.*s\t%s\t%s\n", (int)id.length, (const char*)id.data, (access & UA_ACCESSLEVELMASK_WRITE) ? "rw" : "r",
                       dt ? dt->typeName : "?");
            } else {
                printf("obj\t%.*s\n", (int)id.length, (const char*)id.data);
                browse(client, ref->nodeId.nodeId, depth + 1);
            }
            UA_String_clear(&id);
        }
    }
    UA_BrowseRequest_clear(&req);
    UA_BrowseResponse_clear(&resp);
}

static int remaining = 0;
static void onChange(UA_Client* c, UA_UInt32 s, void* sc, UA_UInt32 m, void* mc, UA_DataValue* value) {
    (void)c; (void)s; (void)sc; (void)m; (void)mc;
    if (getenv("VPLC_PROBE_DEBUG")) printf("callback hasValue=%d status=%s\n", value->hasValue, UA_StatusCode_name(value->status));
    if (value->hasValue && remaining > 0) {
        printf("notify ");
        printValue(&value->value);
        fflush(stdout);
        remaining--;
    }
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s URL COMMAND...\n", argv[0]); return 2; }
    const char* url = argv[1];
    int a = 2;
    const char *user = NULL, *password = NULL;
    while (a + 1 < argc && argv[a][0] == '-') {
        if (!strcmp(argv[a], "-u")) user = argv[a + 1];
        else if (!strcmp(argv[a], "-p")) password = argv[a + 1];
        a += 2;
    }
    UA_Client* client = UA_Client_new();
    UA_ClientConfig* cc = UA_Client_getConfig(client);
    UA_ClientConfig_setDefault(cc);
    if (!getenv("VPLC_PROBE_DEBUG")) {
        cc->logging = &quiet;
        if (cc->eventLoop) cc->eventLoop->logger = &quiet;
    }
    UA_StatusCode rc = user ? UA_Client_connectUsername(client, url, user, password ? password : "") : UA_Client_connect(client, url);
    if (rc != UA_STATUSCODE_GOOD) { printf("error connect %s\n", UA_StatusCode_name(rc)); UA_Client_delete(client); return 1; }

    const char* cmd = argv[a];
    int status = 0;
    if (!strcmp(cmd, "browse")) {
        browse(client, UA_NODEID_NUMERIC(0, UA_NS0ID_OBJECTSFOLDER), 0);
    } else if (!strcmp(cmd, "read") && a + 1 < argc) {
        UA_NodeId id;
        UA_NodeId_parse(&id, UA_STRING(argv[a + 1]));
        UA_Variant v;
        UA_Variant_init(&v);
        rc = UA_Client_readValueAttribute(client, id, &v);
        if (rc == UA_STATUSCODE_GOOD) printValue(&v); else { printf("error %s\n", UA_StatusCode_name(rc)); status = 1; }
        UA_Variant_clear(&v);
        UA_NodeId_clear(&id);
    } else if (!strcmp(cmd, "write") && a + 3 < argc) {
        UA_NodeId id;
        UA_NodeId_parse(&id, UA_STRING(argv[a + 1]));
        const char* t = argv[a + 2];
        const char* val = argv[a + 3];
        UA_Variant v;
        UA_Variant_init(&v);
        UA_Boolean b = !strcmp(val, "true");
        UA_Int16 i16 = (UA_Int16)atoi(val);
        UA_Int32 i32 = atoi(val);
        UA_Float f = (UA_Float)atof(val);
        UA_Double d = atof(val);
        UA_String s = UA_STRING((char*)val);
        if (!strcmp(t, "bool")) UA_Variant_setScalar(&v, &b, &UA_TYPES[UA_TYPES_BOOLEAN]);
        else if (!strcmp(t, "int16")) UA_Variant_setScalar(&v, &i16, &UA_TYPES[UA_TYPES_INT16]);
        else if (!strcmp(t, "int32")) UA_Variant_setScalar(&v, &i32, &UA_TYPES[UA_TYPES_INT32]);
        else if (!strcmp(t, "float")) UA_Variant_setScalar(&v, &f, &UA_TYPES[UA_TYPES_FLOAT]);
        else if (!strcmp(t, "double")) UA_Variant_setScalar(&v, &d, &UA_TYPES[UA_TYPES_DOUBLE]);
        else UA_Variant_setScalar(&v, &s, &UA_TYPES[UA_TYPES_STRING]);
        rc = UA_Client_writeValueAttribute(client, id, &v);
        printf("%s\n", UA_StatusCode_name(rc));
        UA_NodeId_clear(&id);
    } else if (!strcmp(cmd, "subscribe") && a + 2 < argc) {
        UA_NodeId id;
        UA_NodeId_parse(&id, UA_STRING(argv[a + 1]));
        remaining = atoi(argv[a + 2]);
        UA_CreateSubscriptionRequest sreq = UA_CreateSubscriptionRequest_default();
        sreq.requestedPublishingInterval = 100;
        UA_CreateSubscriptionResponse sresp = UA_Client_Subscriptions_create(client, sreq, NULL, NULL, NULL);
        if (sresp.responseHeader.serviceResult != UA_STATUSCODE_GOOD) {
            printf("error subscription %s\n", UA_StatusCode_name(sresp.responseHeader.serviceResult));
            status = 1;
        }
        UA_MonitoredItemCreateRequest mreq = UA_MonitoredItemCreateRequest_default(id);
        mreq.requestedParameters.samplingInterval = 100;
        UA_MonitoredItemCreateResult mres = UA_Client_MonitoredItems_createDataChange(client, sresp.subscriptionId,
                                                                                      UA_TIMESTAMPSTORETURN_BOTH, mreq, NULL, onChange, NULL);
        if (getenv("VPLC_PROBE_DEBUG")) printf("subscription %u (%s) item %u (%s) interval %f\n", (unsigned)sresp.subscriptionId, UA_StatusCode_name(sresp.responseHeader.serviceResult),
            (unsigned)mres.monitoredItemId, UA_StatusCode_name(mres.statusCode), sresp.revisedPublishingInterval);
        if (mres.statusCode != UA_STATUSCODE_GOOD) { printf("error %s\n", UA_StatusCode_name(mres.statusCode)); status = 1; }
        UA_DateTime end = UA_DateTime_nowMonotonic() + 5 * UA_DATETIME_SEC;
        while (remaining > 0 && status == 0 && UA_DateTime_nowMonotonic() < end) {
            UA_StatusCode it = UA_Client_run_iterate(client, 100);
            if (it != UA_STATUSCODE_GOOD) { printf("error iterate %s\n", UA_StatusCode_name(it)); status = 1; }
        }
        if (remaining > 0 && status == 0) { printf("error timeout\n"); status = 1; }
        UA_NodeId_clear(&id);
    } else {
        fprintf(stderr, "unknown command\n");
        status = 2;
    }
    UA_Client_disconnect(client);
    UA_Client_delete(client);
    return status;
}

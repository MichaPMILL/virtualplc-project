// PROFINET IO protocol elements shared by the IO-Device and the IO-Controller:
// Ethernet / RT frames, DCP, connectionless DCE/RPC and the PNIO blocks of the
// connection establishment (IEC 61158-6-10). In-house implementation.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include <array>
#include <string>
#include <vector>

namespace vplc {
namespace pn {

constexpr uint16_t ETHERTYPE_PN = 0x8892;
constexpr uint16_t ETHERTYPE_VLAN = 0x8100;
constexpr uint16_t ETHERTYPE_LLDP = 0x88CC;
constexpr uint16_t RPC_PORT = 34964;

// Frame IDs
constexpr uint16_t FRAME_DCP_HELLO = 0xFEFC;
constexpr uint16_t FRAME_DCP_GETSET = 0xFEFD;
constexpr uint16_t FRAME_DCP_IDENT_REQ = 0xFEFE;
constexpr uint16_t FRAME_DCP_IDENT_RES = 0xFEFF;
constexpr uint16_t FRAME_ALARM_HIGH = 0xFC01;
constexpr uint16_t FRAME_ALARM_LOW = 0xFE01;
/** RT_CLASS_1 cyclic frames */
constexpr uint16_t FRAME_RT1_FIRST = 0x8000;
constexpr uint16_t FRAME_RT1_LAST = 0xFBFF;

// DCP services, options
enum DcpService : uint8_t { DCP_GET = 3, DCP_SET = 4, DCP_IDENTIFY = 5, DCP_HELLO = 6 };
enum DcpServiceType : uint8_t { DCP_REQUEST = 0, DCP_RESPONSE_OK = 1, DCP_RESPONSE_UNSUPPORTED = 5 };
enum DcpOption : uint8_t { DCP_OPT_IP = 1, DCP_OPT_DEVICE = 2, DCP_OPT_DHCP = 3, DCP_OPT_CONTROL = 5, DCP_OPT_INITIATIVE = 6, DCP_OPT_ALL = 0xFF };
enum DcpSubIp : uint8_t { DCP_IP_MAC = 1, DCP_IP_PARAM = 2, DCP_IP_SUITE = 3 };
enum DcpSubDevice : uint8_t {
    DCP_DEV_VENDOR = 1, DCP_DEV_NAME = 2, DCP_DEV_ID = 3, DCP_DEV_ROLE = 4, DCP_DEV_OPTIONS = 5,
    DCP_DEV_ALIAS = 6, DCP_DEV_INSTANCE = 7, DCP_DEV_OEM_ID = 8,
};
enum DcpSubControl : uint8_t { DCP_CTL_START = 1, DCP_CTL_STOP = 2, DCP_CTL_SIGNAL = 3, DCP_CTL_RESPONSE = 4, DCP_CTL_FACTORY_RESET = 5, DCP_CTL_RESET_TO_FACTORY = 6 };

// RPC
enum RpcPacketType : uint8_t { RPC_REQUEST = 0, RPC_PING = 1, RPC_RESPONSE = 2, RPC_FAULT = 3, RPC_WORKING = 4, RPC_NOCALL = 5, RPC_REJECT = 6, RPC_ACK = 7, RPC_FACK = 9 };
enum RpcOpnum : uint16_t { OP_CONNECT = 0, OP_RELEASE = 1, OP_READ = 2, OP_WRITE = 3, OP_CONTROL = 4, OP_READ_IMPLICIT = 5 };
constexpr uint8_t RPC_FLAG_LASTFRAG = 0x02, RPC_FLAG_FRAG = 0x04, RPC_FLAG_NOFACK = 0x08, RPC_FLAG_IDEMPOTENT = 0x20;

// Block types
enum BlockType : uint16_t {
    BT_IOD_WRITE_REQ = 0x0008, BT_IOD_READ_REQ = 0x0009, BT_IM0 = 0x0020,
    BT_AR_REQ = 0x0101, BT_IOCR_REQ = 0x0102, BT_ALARMCR_REQ = 0x0103, BT_EXPECTED_SUBMODULE = 0x0104,
    BT_PRM_END_REQ = 0x0110, BT_APP_READY_REQ = 0x0112, BT_RELEASE_REQ = 0x0114,
    BT_IOD_WRITE_RES = 0x8008, BT_IOD_READ_RES = 0x8009,
    BT_AR_RES = 0x8101, BT_IOCR_RES = 0x8102, BT_ALARMCR_RES = 0x8103, BT_MODULE_DIFF = 0x8104,
    BT_PRM_END_RES = 0x8110, BT_APP_READY_RES = 0x8112, BT_RELEASE_RES = 0x8114,
};
enum ControlCommand : uint16_t { CMD_PRM_END = 0x0001, CMD_APP_READY = 0x0002, CMD_RELEASE = 0x0004, CMD_DONE = 0x0008 };
enum IocrType : uint16_t { IOCR_INPUT = 1, IOCR_OUTPUT = 2 };

// Record indexes
constexpr uint16_t INDEX_IM0 = 0xAFF0;
constexpr uint16_t INDEX_WRITE_MULTIPLE = 0xE040;

/** IOPS / IOCS values */
constexpr uint8_t IOXS_GOOD = 0x80, IOXS_BAD = 0x00;
/** APDU DataStatus: State=primary, DataValid, ProviderState=run, StationProblemIndicator=normal */
constexpr uint8_t DATA_STATUS_RUN = 0x35;
constexpr uint8_t DATA_STATUS_STOP = 0x25;

using Mac = std::array<uint8_t, 6>;
extern const Mac DCP_IDENTIFY_MULTICAST;  // 01:0E:CF:00:00:00

std::string macText(const Mac& m);

/** UUID, stored in its canonical (big endian) byte order. */
struct Uuid {
    uint8_t b[16] = {0};
    bool operator==(const Uuid& o) const;
    bool operator!=(const Uuid& o) const { return !(*this == o); }
    bool isNil() const;
    std::string text() const;
    static Uuid random();
    /** "dea00001-6c97-11d1-8271-00a02442df7d" */
    static Uuid parse(const char* s);
};

extern const Uuid UUID_IO_DEVICE_INTERFACE;      // DEA00001-6C97-11D1-8271-00A02442DF7D
extern const Uuid UUID_IO_CONTROLLER_INTERFACE;  // DEA00002-6C97-11D1-8271-00A02442DF7D
extern const Uuid UUID_EPM_INTERFACE;             // E1AF8308-5D1F-11C9-91A4-08002B14A0FA
/** Object UUID of a PROFINET instance: DEA00000-6C97-11D1-8271-IIII-DDDD-VVVV */
Uuid pnObjectUuid(uint16_t instance, uint16_t deviceId, uint16_t vendorId);

/** Big endian writer with optional little endian fields (RPC header / NDR). */
class Writer {
public:
    explicit Writer(std::vector<uint8_t>& out) : out_(out) {}
    Writer& u8(uint8_t v) { out_.push_back(v); return *this; }
    Writer& u16(uint16_t v) { out_.push_back(uint8_t(v >> 8)); out_.push_back(uint8_t(v)); return *this; }
    Writer& u32(uint32_t v) { u16(uint16_t(v >> 16)); return u16(uint16_t(v)); }
    Writer& le16(uint16_t v) { out_.push_back(uint8_t(v)); out_.push_back(uint8_t(v >> 8)); return *this; }
    Writer& le32(uint32_t v) { le16(uint16_t(v)); return le16(uint16_t(v >> 16)); }
    /** 16 / 32 bit value in the byte order of an RPC data representation */
    Writer& r16(uint16_t v, bool le) { return le ? le16(v) : u16(v); }
    Writer& r32(uint32_t v, bool le) { return le ? le32(v) : u32(v); }
    Writer& bytes(const void* p, size_t n);
    Writer& zeros(size_t n) { out_.insert(out_.end(), n, 0); return *this; }
    Writer& mac(const Mac& m) { return bytes(m.data(), 6); }
    Writer& uuid(const Uuid& u) { return bytes(u.b, 16); }
    /** UUID in RPC header encoding (first three fields in the data representation byte order) */
    Writer& uuidRpc(const Uuid& u, bool le);
    Writer& str(const std::string& s) { return bytes(s.data(), s.size()); }
    Writer& padTo(size_t align, size_t base = 0);
    size_t size() const { return out_.size(); }
    void put16(size_t at, uint16_t v) { out_[at] = uint8_t(v >> 8); out_[at + 1] = uint8_t(v); }
    void put16le(size_t at, uint16_t v) { out_[at] = uint8_t(v); out_[at + 1] = uint8_t(v >> 8); }
    void put32(size_t at, uint32_t v) { put16(at, uint16_t(v >> 16)); put16(at + 2, uint16_t(v)); }
    void put32r(size_t at, uint32_t v, bool le);
    /** Starts a PNIO block (type, length, version); endBlock() writes the length. */
    size_t beginBlock(uint16_t type, uint8_t versionLow = 0);
    void endBlock(size_t start);
    std::vector<uint8_t>& data() { return out_; }

private:
    std::vector<uint8_t>& out_;
};

/** Bounds-checked reader; ok() turns false on the first overrun. */
class Reader {
public:
    Reader(const uint8_t* p, size_t n) : p_(p), n_(n) {}
    uint8_t u8();
    uint16_t u16();
    uint32_t u32();
    uint16_t r16(bool le);
    uint32_t r32(bool le);
    Mac mac();
    Uuid uuid();
    Uuid uuidRpc(bool le);
    std::string str(size_t n);
    const uint8_t* take(size_t n);
    void skip(size_t n) { take(n); }
    size_t pos() const { return pos_; }
    size_t remaining() const { return ok_ ? n_ - pos_ : 0; }
    bool ok() const { return ok_; }
    const uint8_t* here() const { return p_ + pos_; }
    void fail() { ok_ = false; }

private:
    bool need(size_t k);
    const uint8_t* p_;
    size_t n_;
    size_t pos_ = 0;
    bool ok_ = true;
};

// ---------------------------------------------------------------------------
// Ethernet
// ---------------------------------------------------------------------------

struct EthFrame {
    Mac dst{}, src{};
    uint16_t type = 0;
    /** VLAN tag control information (0 when untagged) */
    uint16_t vlan = 0;
    const uint8_t* payload = nullptr;
    size_t length = 0;
};
bool parseEth(const uint8_t* p, size_t n, EthFrame& out);
/** Ethernet header (+ VLAN tag when vlan != 0) and EtherType PN */
void writeEthPn(Writer& w, const Mac& dst, const Mac& src, uint16_t vlan);

// ---------------------------------------------------------------------------
// DCP
// ---------------------------------------------------------------------------

struct DcpBlock {
    uint8_t option = 0, suboption = 0;
    const uint8_t* data = nullptr;
    uint16_t length = 0;
};

struct DcpMessage {
    uint16_t frameId = 0;
    uint8_t service = 0, type = 0;
    uint32_t xid = 0;
    uint16_t delay = 0;  // response delay factor (identify request)
    std::vector<DcpBlock> blocks;
    const DcpBlock* find(uint8_t option, uint8_t suboption) const;
};
bool parseDcp(const uint8_t* p, size_t n, DcpMessage& out);

/** DCP frame builder: header, then blocks, then finish() sets the data length. */
class DcpBuilder {
public:
    DcpBuilder(std::vector<uint8_t>& out, const Mac& dst, const Mac& src, uint16_t frameId, uint8_t service, uint8_t type, uint32_t xid, uint16_t delay = 0);
    /** Block with a 2-byte BlockInfo / BlockQualifier prefix (responses, set requests) */
    void block(uint8_t option, uint8_t suboption, uint16_t info, const void* data, size_t n);
    /** Block without prefix (identify filters, get requests) */
    void raw(uint8_t option, uint8_t suboption, const void* data, size_t n);
    void finish();

private:
    Writer w_;
    size_t lengthAt_, dataStart_;
};

/** Valid PROFINET name of station (lower case labels of letters, digits, '-') */
bool validStationName(const std::string& name);

// ---------------------------------------------------------------------------
// Connectionless DCE/RPC
// ---------------------------------------------------------------------------

struct RpcHeader {
    uint8_t type = RPC_REQUEST;
    uint8_t flags1 = 0, flags2 = 0;
    bool le = true;  // data representation: little endian integers
    uint8_t serialHigh = 0, serialLow = 0;
    Uuid object, interface, activity;
    uint32_t serverBoot = 0, interfaceVersion = 1, sequence = 0;
    uint16_t opnum = 0, interfaceHint = 0xFFFF, activityHint = 0xFFFF;
    uint16_t bodyLength = 0, fragment = 0;
};
constexpr size_t RPC_HEADER_SIZE = 80;
bool parseRpc(const uint8_t* p, size_t n, RpcHeader& out);
/** Writes an RPC header; bodyLength is patched by finishRpc(). */
void writeRpc(Writer& w, const RpcHeader& h);
void finishRpc(std::vector<uint8_t>& packet);

/** NDR header of a PNIO request / response body. */
struct NdrHeader {
    uint32_t status = 0;  // response: PNIO status; request: ArgsMaximum
    uint32_t argsLength = 0, maximumCount = 0, offset = 0, actualCount = 0;
};
constexpr size_t NDR_HEADER_SIZE = 20;
/** Reads the NDR header of a request (ArgsMaximum) or a response (PNIO status, as bytes). */
bool parseNdr(const uint8_t* body, size_t n, bool le, bool response, NdrHeader& out, const uint8_t*& blocks, size_t& blocksLength);
/** Writes the NDR header of a request; finishNdr() patches the lengths once the blocks are written. */
size_t writeNdrRequest(Writer& w, uint32_t argsMaximum, bool le);
/** Writes the NDR header of a response (maximumCount: ArgsMaximum of the request). */
size_t writeNdrResponse(Writer& w, uint32_t status, uint32_t maximumCount, bool le);
void finishNdr(Writer& w, size_t at, bool le);

/** PNIO status (ErrorCode, ErrorDecode, ErrorCode1, ErrorCode2) */
constexpr uint32_t pnioStatus(uint8_t code, uint8_t decode, uint8_t code1, uint8_t code2) {
    return (uint32_t(code) << 24) | (uint32_t(decode) << 16) | (uint32_t(code1) << 8) | code2;
}
constexpr uint32_t PNIO_OK = 0;

/** A PNIO block inside a body. */
struct Block {
    uint16_t type = 0;
    uint8_t versionHigh = 0, versionLow = 0;
    const uint8_t* data = nullptr;  // after the version bytes
    size_t length = 0;
};
/** Splits a sequence of blocks; false if malformed. */
bool parseBlocks(const uint8_t* p, size_t n, std::vector<Block>& out);

// ---------------------------------------------------------------------------
// Connection establishment
// ---------------------------------------------------------------------------

struct IoDataObject {
    uint16_t slot = 0, subslot = 0, frameOffset = 0;
};

struct IocrInfo {
    uint16_t type = 0, reference = 0, lt = ETHERTYPE_PN;
    uint32_t properties = 1;  // RT_CLASS_1
    uint16_t dataLength = 40, frameId = 0, sendClockFactor = 32, reductionRatio = 32, phase = 1, sequence = 0;
    uint32_t frameSendOffset = 0xFFFFFFFF;
    uint16_t watchdogFactor = 3, dataHoldFactor = 3, tagHeader = 0xC000;
    Mac multicast{};
    uint32_t api = 0;
    std::vector<IoDataObject> data;  // IO data objects (data + IOPS)
    std::vector<IoDataObject> iocs;  // consumer status of the other direction
    /** cycle time in microseconds */
    uint32_t cycleUs() const { return uint32_t(uint64_t(sendClockFactor) * reductionRatio * 3125 / 100); }
};

struct ArInfo {
    uint16_t type = 1;  // IOCARSingle
    Uuid uuid;
    uint16_t sessionKey = 0;
    Mac initiatorMac{};
    Uuid initiatorObject;
    uint32_t properties = 0x00000011;  // state active, parametrization server = CM initiator
    uint16_t activityTimeout = 600;    // x 100 ms
    uint16_t initiatorUdpPort = RPC_PORT;
    std::string stationName;
};

struct AlarmCrInfo {
    uint16_t type = 1, lt = ETHERTYPE_PN;
    uint32_t properties = 0;
    uint16_t rtaTimeoutFactor = 1, rtaRetries = 3, localReference = 1, maxDataLength = 200;
    uint16_t tagHigh = 0xC000, tagLow = 0xA000;
};

struct ExpectedSubmodule {
    uint32_t api = 0;
    uint16_t slot = 0;
    uint32_t moduleIdent = 0;
    uint16_t subslot = 0;
    uint32_t submoduleIdent = 0;
    uint16_t properties = 0;  // bits 0-1: 0 no IO, 1 input, 2 output, 3 input + output
    uint16_t inLength = 0, outLength = 0;
};

struct ConnectRequest {
    ArInfo ar;
    std::vector<IocrInfo> iocrs;
    AlarmCrInfo alarm;
    bool haveAlarm = false;
    std::vector<ExpectedSubmodule> submodules;
};
bool parseConnectRequest(const std::vector<Block>& blocks, ConnectRequest& out, std::string& error);
void writeArBlockReq(Writer& w, const ArInfo& ar);
void writeIocrBlockReq(Writer& w, const IocrInfo& cr);
void writeAlarmCrBlockReq(Writer& w, const AlarmCrInfo& a);
/** One ExpectedSubmoduleBlockReq per slot */
void writeExpectedSubmodules(Writer& w, const std::vector<ExpectedSubmodule>& subs);

struct ConnectResponse {
    uint16_t arType = 1;
    Uuid arUuid;
    uint16_t sessionKey = 0;
    Mac responderMac{};
    uint16_t responderUdpPort = RPC_PORT;
    struct Cr { uint16_t type, reference, frameId; };
    std::vector<Cr> iocrs;
    uint16_t alarmType = 1, alarmReference = 0, alarmMaxLength = 200;
    struct Diff { uint32_t api; uint16_t slot; uint32_t moduleIdent; uint16_t moduleState; uint16_t subslot; uint32_t submoduleIdent; uint16_t submoduleState; };
    std::vector<Diff> diffs;
};
void writeConnectResponse(Writer& w, const ConnectResponse& r);
bool parseConnectResponse(const std::vector<Block>& blocks, ConnectResponse& out);

/** IODControlReq / Res (PrmEnd, ApplicationReady, Release) */
struct ControlBlock {
    uint16_t type = 0;
    Uuid arUuid;
    uint16_t sessionKey = 0;
    uint16_t command = 0, properties = 0;
};
bool parseControl(const Block& b, ControlBlock& out);
void writeControl(Writer& w, const ControlBlock& c);

/** IOD Read / Write request header */
struct RecordHeader {
    uint16_t type = 0, sequence = 0;
    Uuid arUuid;
    uint32_t api = 0;
    uint16_t slot = 0, subslot = 0, index = 0;
    uint32_t length = 0;
};
bool parseRecordHeader(const Block& b, RecordHeader& out);
void writeRecordReq(Writer& w, const RecordHeader& h);
/** Read / write response header (additional values 0) */
void writeRecordRes(Writer& w, const RecordHeader& h, uint32_t status);

// ---------------------------------------------------------------------------
// Alarms (acyclic real-time: RTA over the alarm CR)
// ---------------------------------------------------------------------------

enum RtaType : uint8_t { RTA_DATA = 1, RTA_NACK = 2, RTA_ACK = 3, RTA_ERR = 4 };
enum AlarmType : uint16_t {
    ALARM_DIAGNOSIS = 0x0001, ALARM_PROCESS = 0x0002, ALARM_PULL = 0x0003, ALARM_PLUG = 0x0004, ALARM_STATUS = 0x0005,
    ALARM_UPDATE = 0x0006, ALARM_DIAGNOSIS_DISAPPEARS = 0x000C,
};
constexpr uint16_t BT_ALARM_HIGH = 0x0001, BT_ALARM_LOW = 0x0002, BT_ALARM_ACK_HIGH = 0x8001, BT_ALARM_ACK_LOW = 0x8002;
constexpr uint16_t USI_CHANNEL_DIAGNOSIS = 0x8000;
constexpr uint16_t VLAN_ALARM_HIGH = 0xC000, VLAN_ALARM_LOW = 0xA000;

struct RtaHeader {
    uint16_t dst = 0, src = 0;
    uint8_t type = RTA_DATA, flags = 0x11;  // window size 1, acknowledge requested
    uint16_t sendSeq = 0, ackSeq = 0;
    const uint8_t* sdu = nullptr;
    size_t length = 0;
};
/** Parses the RTA-PDU after the frame ID */
bool parseRta(const uint8_t* p, size_t n, RtaHeader& out);
/** Alarm frame (high or low priority) with an RTA-PDU */
void writeRtaFrame(std::vector<uint8_t>& out, const Mac& dst, const Mac& src, bool high, const RtaHeader& h, const uint8_t* sdu, size_t n);

/** AlarmNotification (block 0x0001 / 0x0002) or AlarmAck (0x8001 / 0x8002) */
struct AlarmInfo {
    uint16_t blockType = BT_ALARM_LOW;
    uint16_t type = ALARM_DIAGNOSIS;
    uint32_t api = 0;
    uint16_t slot = 0, subslot = 0;
    uint32_t moduleIdent = 0, submoduleIdent = 0;
    uint16_t specifier = 0;
    uint16_t usi = 0;             // user structure identifier (0 = none)
    std::vector<uint8_t> data;    // after the USI
    uint32_t status = 0;          // AlarmAck: PNIO status
};
bool parseAlarm(const uint8_t* p, size_t n, AlarmInfo& out);
void writeAlarmNotification(Writer& w, const AlarmInfo& a);
void writeAlarmAck(Writer& w, const AlarmInfo& a);

/** One channel diagnosis entry (USI 0x8000: channel, properties, error type) */
struct ChannelDiag {
    uint16_t channel = 0x8000, properties = 0, errorType = 0;
    bool disappears() const { return ((properties >> 11) & 3) == 2; }
};
std::vector<ChannelDiag> channelDiagnoses(const AlarmInfo& a);
const char* channelErrorText(uint16_t errorType);

/** Cyclic RT frame: builds the frame around a C_SDU. */
void writeRtFrame(std::vector<uint8_t>& out, const Mac& dst, const Mac& src, uint16_t vlan, uint16_t frameId,
                  const uint8_t* csdu, size_t length, uint16_t cycleCounter, uint8_t dataStatus);

}  // namespace pn
}  // namespace vplc

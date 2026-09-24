cmake_minimum_required(VERSION 3.16)
project(virtualplc_runtime C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Portable core: no exceptions, no RTTI, no heap (same constraints as on microcontrollers)
add_library(vplc_core STATIC
  core/crc32.cpp
  core/program.cpp
  core/vm.cpp
  core/protocol.cpp
  core/cpu.cpp
  core/hmi.cpp
  core/s7.cpp)
target_include_directories(vplc_core PUBLIC core)
target_compile_options(vplc_core PRIVATE -Wall -Wextra -Wpedantic -fno-exceptions -fno-rtti)

add_executable(vplc-sim tools/vplc-sim.cpp)
target_link_libraries(vplc-sim vplc_core m)
target_compile_options(vplc-sim PRIVATE -Wall -Wextra)

# OPC UA server: open62541 (MPL-2.0), single-file distribution downloaded at configure
# time and checked against its SHA-256; VPLC_OPEN62541_DIR points to a local copy for
# offline builds. Encryption is left out (security policy None + user name / password).
option(VPLC_OPCUA "Build the OPC UA server (open62541)" ON)
set(VPLC_OPEN62541_VERSION 1.4.9)
set(VPLC_OPEN62541_DIR "" CACHE PATH "Folder containing open62541.c / open62541.h (offline builds)")

if(UNIX AND VPLC_OPCUA)
  set(o62 ${CMAKE_BINARY_DIR}/open62541)
  set(src ${VPLC_OPEN62541_DIR})
  if(NOT src)
    set(src ${CMAKE_BINARY_DIR}/open62541-download)
    set(base https://github.com/open62541/open62541/releases/download/v${VPLC_OPEN62541_VERSION})
    foreach(f IN ITEMS c h)
      if(f STREQUAL "c")
        set(hash c1dee3f67cb43d7ee9368138fa99f61e59437369234ef24348cc7a8220ef482a)
      else()
        set(hash 34d915f1bfb3af80bc36dd5273dadfa4bf8f973315167c567e448095f77b8aae)
      endif()
      if(NOT EXISTS ${src}/open62541.${f})
        message(STATUS "Downloading open62541 ${VPLC_OPEN62541_VERSION} (open62541.${f})")
        file(DOWNLOAD ${base}/open62541.${f} ${src}/open62541.${f} EXPECTED_HASH SHA256=${hash} TLS_VERIFY ON STATUS st)
        list(GET st 0 code)
        if(NOT code EQUAL 0)
          message(FATAL_ERROR "Cannot download open62541 (${st}): use -DVPLC_OPEN62541_DIR=<folder> or -DVPLC_OPCUA=OFF")
        endif()
      endif()
    endforeach()
  endif()
  # Configuration: no encryption (no mbedTLS dependency)
  file(READ ${src}/open62541.h header)
  foreach(feature IN ITEMS UA_ENABLE_ENCRYPTION_MBEDTLS UA_ENABLE_PUBSUB_ENCRYPTION)
    string(REPLACE "#define ${feature}\n" "/* ${feature} disabled by VirtualPLC */\n" header "${header}")
  endforeach()
  file(WRITE ${o62}/open62541.h "${header}")
  # The PubSub security sources of the single-file distribution assume encryption: drop them
  file(READ ${src}/open62541.c body)
  string(FIND "${body}" "/**** amalgamated original file \"/src/pubsub/ua_pubsub_security.c\" ****/" cut)
  if(cut GREATER -1)
    string(SUBSTRING "${body}" ${cut} -1 tail)
    string(FIND "${tail}" "/**** amalgamated original file" next REVERSE)
    string(SUBSTRING "${tail}" 10 -1 rest)
    string(FIND "${rest}" "/**** amalgamated original file" next)
    math(EXPR next "${next} + 10")
    string(SUBSTRING "${body}" 0 ${cut} head)
    string(SUBSTRING "${tail}" ${next} -1 tail)
    set(body "${head}${tail}")
  endif()
  file(WRITE ${o62}/open62541.c "${body}")
  add_library(open62541 STATIC ${o62}/open62541.c)
  target_include_directories(open62541 SYSTEM PUBLIC ${o62})
  set_target_properties(open62541 PROPERTIES C_STANDARD 99 C_EXTENSIONS ON)
  # open62541 relies on type punning: strict aliasing optimisations break its timers
  target_compile_options(open62541 PRIVATE -w -O2 -fno-strict-aliasing)
  find_package(Threads REQUIRED)
  target_link_libraries(open62541 PUBLIC Threads::Threads)
endif()

if(UNIX)
  add_executable(vplc-cpu
    platform/linux/main.cpp
    platform/linux/linux_platform.cpp
    platform/linux/modbus.cpp
    platform/linux/profinet/pn_proto.cpp
    platform/linux/profinet/pn_net.cpp
    platform/linux/profinet/pn_stack.cpp
    platform/linux/profinet/pn_device.cpp
    platform/linux/profinet/pn_controller.cpp)
  target_include_directories(vplc-cpu PRIVATE platform/linux)
  find_package(Threads REQUIRED)
  target_link_libraries(vplc-cpu vplc_core m Threads::Threads)
  target_compile_options(vplc-cpu PRIVATE -Wall -Wextra)
  if(VPLC_OPCUA)
    target_sources(vplc-cpu PRIVATE platform/linux/opcua.cpp)
    target_link_libraries(vplc-cpu open62541)
    target_compile_definitions(vplc-cpu PRIVATE VPLC_WITH_OPCUA=1)
    # Test client used by the end-to-end tests (browse / read / write / subscribe)
    add_executable(vplc-opcua-probe tools/opcua-probe.c)
    target_link_libraries(vplc-opcua-probe open62541)
  endif()
  install(TARGETS vplc-cpu RUNTIME DESTINATION bin)
endif()

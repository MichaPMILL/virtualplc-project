cmake_minimum_required(VERSION 3.16)
project(virtualplc_runtime CXX)

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

if(UNIX)
  add_executable(vplc-cpu
    platform/linux/main.cpp
    platform/linux/linux_platform.cpp
    platform/linux/modbus.cpp)
  target_link_libraries(vplc-cpu vplc_core m)
  target_compile_options(vplc-cpu PRIVATE -Wall -Wextra)
  install(TARGETS vplc-cpu RUNTIME DESTINATION bin)
endif()

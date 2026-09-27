cmake_minimum_required(VERSION 3.12)
project(rct_z80_daemon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

execute_process(
    COMMAND verilator --getenv VERILATOR_ROOT
    OUTPUT_VARIABLE VERILATOR_ROOT
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(VERILATOR_ROOT STREQUAL "")
    set(VERILATOR_ROOT "/usr/share/verilator")
endif()

set(RTL_SRCS
    ${CMAKE_CURRENT_SOURCE_DIR}/rtl/z80_top.v
    ${CMAKE_CURRENT_SOURCE_DIR}/rtl/z80_alu.v
    ${CMAKE_CURRENT_SOURCE_DIR}/rtl/z80_registers.v
    ${CMAKE_CURRENT_SOURCE_DIR}/rtl/z80_control.v
)

set(VERILATOR_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/obj_dir")
set(VERILATOR_STATIC_LIB "${VERILATOR_OUTPUT_DIR}/Vz80_top__ALL.a")
set(VERILATOR_HEADER "${VERILATOR_OUTPUT_DIR}/Vz80_top.h")

add_custom_command(
    OUTPUT "${VERILATOR_STATIC_LIB}" "${VERILATOR_HEADER}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${VERILATOR_OUTPUT_DIR}"
    COMMAND verilator -Wall --cc -I${CMAKE_CURRENT_SOURCE_DIR}/rtl --Mdir "${VERILATOR_OUTPUT_DIR}" ${RTL_SRCS}
    COMMAND make -C "${VERILATOR_OUTPUT_DIR}" -f Vz80_top.mk
    DEPENDS ${RTL_SRCS}
    COMMENT "Verilating Z80 RTL model"
)

add_custom_target(generate_verilator DEPENDS "${VERILATOR_STATIC_LIB}")

set(DAEMON_SRCS
    src/main.cpp
    src/z80_daemon.cpp
    ${VERILATOR_ROOT}/include/verilated.cpp
)

add_executable(rct_z80_daemon ${DAEMON_SRCS})
add_dependencies(rct_z80_daemon generate_verilator)

target_include_directories(rct_z80_daemon PRIVATE
    src
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${VERILATOR_ROOT}/include
    ${VERILATOR_ROOT}/include/vltstd
    ${VERILATOR_OUTPUT_DIR}
)

find_package(Threads REQUIRED)
target_link_libraries(rct_z80_daemon PRIVATE
    Threads::Threads
    "${VERILATOR_STATIC_LIB}"
    rt
)

set_target_properties(rct_z80_daemon PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
)

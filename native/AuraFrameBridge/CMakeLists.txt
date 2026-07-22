cmake_minimum_required(VERSION 3.20)

project(AuraFrameBridgePoC LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(AuraFrameWriter
    src/AuraFrameWriter.cpp
)

add_executable(AuraFrameReader
    src/AuraFrameReader.cpp
)
#!/bin/bash

function join_strings {
    local IFS="$1";
    shift;
    echo "$*";
}

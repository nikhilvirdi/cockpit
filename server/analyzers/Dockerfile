FROM golang:1.27.4-trixie AS go-build
WORKDIR /build
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /go-analyze .

FROM golang:1.27.4-trixie AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang-19 libclang-19-dev llvm-19-dev openjdk-21-jdk-headless python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/cockpit
COPY python-requirements.txt .
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir -r python-requirements.txt

FROM toolchain AS build
COPY java/dependencies.txt .
RUN mkdir jars && while read -r artifact; do \
    curl --fail --silent --show-error --location "https://repo.maven.apache.org/maven2/$artifact" -o "jars/$(basename "$artifact")"; \
    done < dependencies.txt
COPY java/Analyze.java clang/main.cpp ./
RUN javac -cp 'jars/*' Analyze.java
RUN clang++-19 -std=c++17 -O2 -I/usr/lib/llvm-19/include main.cpp -L/usr/lib/llvm-19/lib \
    -Wl,-rpath,/usr/lib/llvm-19/lib -l:libclang-cpp.so.19.1 -lLLVM-19 -o clang-analyze

FROM toolchain
COPY --from=go-build /go-analyze .
COPY --from=build /opt/cockpit/jars ./jars
COPY --from=build /opt/cockpit/Analyze*.class ./
COPY --from=build /opt/cockpit/clang-analyze .
COPY python.py run.sh ./
ENV PATH="/usr/local/go/bin:/usr/bin:/bin" GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local GOTELEMETRY=off \
    GOPACKAGESDRIVER=off GOENV=off CGO_ENABLED=0 GOCACHE=/tmp/go-cache GOPATH=/tmp/go GIT_CONFIG_NOSYSTEM=1
ENTRYPOINT ["/bin/sh", "/opt/cockpit/run.sh"]

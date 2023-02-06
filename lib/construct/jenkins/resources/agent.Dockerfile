FROM unityci/editor:2021.3.14f1-ios-1.0 

# An example Dockerfile of a Unity image with Python and Node.js

RUN apt-get update && apt-get install -y python
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt-get install -y nodejs
